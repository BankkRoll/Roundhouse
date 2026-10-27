package imagepush

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sync"
	"sync/atomic"
)

// Manifest media types a push reads.
const (
	mediaOCIIndex       = "application/vnd.oci.image.index.v1+json"
	mediaOCIManifest    = "application/vnd.oci.image.manifest.v1+json"
	mediaDockerList     = "application/vnd.docker.distribution.manifest.list.v2+json"
	mediaDockerManifest = "application/vnd.docker.distribution.manifest.v2+json"
)

const manifestAccept = mediaOCIIndex + ", " + mediaOCIManifest + ", " + mediaDockerList + ", " + mediaDockerManifest

// maxManifestBytes bounds a manifest read from the source.
const maxManifestBytes = 4 << 20

// blobConcurrency is how many blobs one push copies at once.
const blobConcurrency = 3

var digestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

type platform struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	Variant      string `json:"variant,omitempty"`
}

type descriptor struct {
	MediaType string    `json:"mediaType"`
	Digest    string    `json:"digest"`
	Size      int64     `json:"size"`
	Platform  *platform `json:"platform,omitempty"`
}

// manifest holds the fields of an image manifest or an index a push uses.
type manifest struct {
	MediaType string       `json:"mediaType"`
	Config    *descriptor  `json:"config"`
	Layers    []descriptor `json:"layers"`
	Manifests []descriptor `json:"manifests"`
}

// copier copies one image from the source registry to the target.
type copier struct {
	src, dst        *registry
	srcRepo, srcDig string
	dstRepo, dstTag string
	progress        func(string)
	uploaded        atomic.Int64
}

// run copies the linux/amd64 image and returns the pushed manifest's
// digest; uploaded counts the blob bytes sent.
func (c *copier) run(ctx context.Context) (string, error) {
	body, mt, err := c.getManifest(ctx, c.srcDig)
	if err != nil {
		return "", err
	}
	digest := c.srcDig
	if isIndex(mt) {
		d, err := selectAMD64(body)
		if err != nil {
			return "", err
		}
		c.progress(fmt.Sprintf("selected the linux/amd64 manifest %s", d.Digest))
		if body, mt, err = c.getManifest(ctx, d.Digest); err != nil {
			return "", err
		}
		if isIndex(mt) {
			return "", fmt.Errorf("manifest %s: the linux/amd64 entry is itself an index", d.Digest)
		}
		digest = d.Digest
	}
	blobs, err := imageBlobs(body)
	if err != nil {
		return "", fmt.Errorf("manifest %s: %w", digest, err)
	}
	if err := c.login(ctx); err != nil {
		return "", err
	}
	if err := c.copyBlobs(ctx, blobs); err != nil {
		return "", err
	}
	if err := c.putManifest(ctx, body, mt, digest); err != nil {
		return "", err
	}
	c.progress(fmt.Sprintf("pushed manifest %s", digest))
	return digest, nil
}

// login authenticates to the target once, before the blobs are copied
// concurrently, so a rejected credential fails the push at once and the
// blob requests share one token.
func (c *copier) login(ctx context.Context) error {
	resp, err := c.dst.do(ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, c.dst.url("/v2/"), nil)
	})
	if err != nil {
		return fmt.Errorf("target registry: %w", err)
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return statusError("target registry: the credential was rejected", resp)
	}
	return nil
}

func isIndex(mt string) bool { return mt == mediaOCIIndex || mt == mediaDockerList }

// getManifest reads a manifest from the source by digest and verifies it.
func (c *copier) getManifest(ctx context.Context, digest string) ([]byte, string, error) {
	resp, err := c.src.do(ctx, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.src.url("/v2/"+c.srcRepo+"/manifests/"+digest), nil)
		if err == nil {
			req.Header.Set("Accept", manifestAccept)
		}
		return req, err
	})
	if err != nil {
		return nil, "", fmt.Errorf("local registry: %w", err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return nil, "", statusError("local registry: GET manifest "+digest, resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("local registry: read manifest %s: %w", digest, err)
	}
	if len(body) > maxManifestBytes {
		return nil, "", fmt.Errorf("local registry: manifest %s is larger than %d bytes", digest, maxManifestBytes)
	}
	if got := sha256Digest(body); got != digest {
		return nil, "", fmt.Errorf("local registry: manifest %s has digest %s", digest, got)
	}
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, "", fmt.Errorf("local registry: manifest %s: invalid JSON", digest)
	}
	mt := m.MediaType
	if mt == "" {
		mt, _, _ = mime.ParseMediaType(resp.Header.Get("Content-Type"))
	}
	if mt == "" || mt == "application/json" {
		// COMPAT: an OCI manifest or index may omit mediaType.
		mt = mediaOCIManifest
		if m.Manifests != nil {
			mt = mediaOCIIndex
		}
	}
	switch mt {
	case mediaOCIIndex, mediaOCIManifest, mediaDockerList, mediaDockerManifest:
		return body, mt, nil
	}
	return nil, "", fmt.Errorf("local registry: manifest %s has unsupported media type %q", digest, mt)
}

// selectAMD64 picks the linux/amd64 manifest of an index.
func selectAMD64(body []byte) (descriptor, error) {
	var idx manifest
	if err := json.Unmarshal(body, &idx); err != nil {
		return descriptor{}, errors.New("invalid image index")
	}
	for _, d := range idx.Manifests {
		if d.Platform != nil && d.Platform.OS == "linux" && d.Platform.Architecture == "amd64" {
			if !digestRE.MatchString(d.Digest) {
				return descriptor{}, fmt.Errorf("image index: invalid digest %q", d.Digest)
			}
			return d, nil
		}
	}
	return descriptor{}, errors.New("the image has no linux/amd64 variant")
}

// imageBlobs lists an image manifest's config and layers, each once.
func imageBlobs(body []byte) ([]descriptor, error) {
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, errors.New("invalid JSON")
	}
	if m.Config == nil {
		return nil, errors.New("no config")
	}
	seen := map[string]bool{}
	var out []descriptor
	for _, d := range append([]descriptor{*m.Config}, m.Layers...) {
		if !digestRE.MatchString(d.Digest) || d.Size < 0 {
			return nil, fmt.Errorf("invalid blob descriptor %q", d.Digest)
		}
		if !seen[d.Digest] {
			seen[d.Digest] = true
			out = append(out, d)
		}
	}
	return out, nil
}

// copyBlobs copies blobs, a few at a time; the first failure stops the rest.
func (c *copier) copyBlobs(ctx context.Context, blobs []descriptor) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sem := make(chan struct{}, blobConcurrency)
	var wg sync.WaitGroup
	var once sync.Once
	var first error
	for _, d := range blobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			if err := c.copyBlob(ctx, d); err != nil {
				once.Do(func() {
					first = err
					cancel()
				})
			}
		}()
	}
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}

// copyBlob uploads one blob the target lacks, streaming it from the source
// with a monolithic PUT.
func (c *copier) copyBlob(ctx context.Context, d descriptor) error {
	what := "blob " + d.Digest
	resp, err := c.dst.do(ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodHead, c.dst.url("/v2/"+c.dstRepo+"/blobs/"+d.Digest), nil)
	})
	if err != nil {
		return fmt.Errorf("target registry: %s: %w", what, err)
	}
	drain(resp)
	switch resp.StatusCode {
	case http.StatusOK:
		c.progress(fmt.Sprintf("%s: already in the target registry", what))
		return nil
	case http.StatusNotFound:
	default:
		return statusError("target registry: HEAD "+what, resp)
	}

	resp, err = c.dst.do(ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodPost, c.dst.url("/v2/"+c.dstRepo+"/blobs/uploads/"), nil)
	})
	if err != nil {
		return fmt.Errorf("target registry: start upload of %s: %w", what, err)
	}
	if resp.StatusCode != http.StatusAccepted {
		defer drain(resp)
		return statusError("target registry: start upload of "+what, resp)
	}
	drain(resp)
	loc, err := resp.Request.URL.Parse(resp.Header.Get("Location"))
	if err != nil || resp.Header.Get("Location") == "" {
		return fmt.Errorf("target registry: start upload of %s: no valid Location", what)
	}
	if c.dst.scheme == "https" && loc.Scheme != "https" {
		return fmt.Errorf("target registry: upload location of %s is not https", what)
	}
	q := loc.Query()
	q.Set("digest", d.Digest)
	loc.RawQuery = q.Encode()

	var v *verifier
	resp, err = c.dst.do(ctx, func() (*http.Request, error) {
		src, err := c.openBlob(ctx, d)
		if err != nil {
			return nil, err
		}
		v = &verifier{r: src, h: sha256.New(), want: d.Digest, size: d.Size}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, loc.String(), v)
		if err != nil {
			_ = src.Close()
			return nil, err
		}
		req.ContentLength = d.Size
		req.Header.Set("Content-Type", "application/octet-stream")
		return req, nil
	})
	if v != nil && v.failure() != nil {
		return v.failure()
	}
	if err != nil {
		return fmt.Errorf("target registry: upload %s: %w", what, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusCreated {
		return statusError("target registry: upload "+what, resp)
	}
	c.uploaded.Add(d.Size)
	c.progress(fmt.Sprintf("%s: uploaded %d bytes", what, d.Size))
	return nil
}

// openBlob starts reading a blob from the source.
func (c *copier) openBlob(ctx context.Context, d descriptor) (io.ReadCloser, error) {
	resp, err := c.src.do(ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(ctx, http.MethodGet, c.src.url("/v2/"+c.srcRepo+"/blobs/"+d.Digest), nil)
	})
	if err != nil {
		return nil, fmt.Errorf("local registry: blob %s: %w", d.Digest, err)
	}
	if resp.StatusCode != http.StatusOK {
		defer drain(resp)
		return nil, statusError("local registry: GET blob "+d.Digest, resp)
	}
	return resp.Body, nil
}

// putManifest pushes the manifest's exact bytes to the target tag.
func (c *copier) putManifest(ctx context.Context, body []byte, mt, digest string) error {
	resp, err := c.dst.do(ctx, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.dst.url("/v2/"+c.dstRepo+"/manifests/"+c.dstTag), bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", mt)
		}
		return req, err
	})
	if err != nil {
		return fmt.Errorf("target registry: push manifest: %w", err)
	}
	defer drain(resp)
	if resp.StatusCode/100 != 2 {
		return statusError("target registry: push manifest "+digest, resp)
	}
	if got := resp.Header.Get("Docker-Content-Digest"); got != "" && got != digest {
		return fmt.Errorf("target registry: pushed manifest %s but the registry reports %s", digest, got)
	}
	return nil
}

// verifier passes a blob through, failing instead of delivering its last
// bytes when they don't hash to the expected digest, so a corrupt blob is
// never completely uploaded.
type verifier struct {
	r    io.ReadCloser
	h    hash.Hash
	want string
	size int64
	n    int64

	// NOTE: the transport reads the body on its own goroutine, which can
	// still be running when an early response returns from Do.
	mu  sync.Mutex
	err error
}

func (v *verifier) Read(p []byte) (int, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.err != nil {
		return 0, v.err
	}
	if v.n == v.size {
		if err := v.check(); err != nil {
			return 0, err
		}
		return 0, io.EOF
	}
	if rem := v.size - v.n; int64(len(p)) > rem {
		p = p[:rem]
	}
	n, err := v.r.Read(p)
	v.h.Write(p[:n])
	v.n += int64(n)
	if v.n == v.size {
		if err := v.check(); err != nil {
			return 0, err
		}
		return n, nil
	}
	if errors.Is(err, io.EOF) {
		v.err = fmt.Errorf("local registry: blob %s ended after %d of %d bytes", v.want, v.n, v.size)
		return n, v.err
	}
	return n, err
}

// check fails the read when the bytes seen so far, which are all of the
// blob, don't match its digest.
func (v *verifier) check() error {
	if got := "sha256:" + hex.EncodeToString(v.h.Sum(nil)); got != v.want {
		v.err = fmt.Errorf("local registry: blob %s has digest %s; push aborted", v.want, got)
	}
	return v.err
}

// failure is why reading failed, or nil.
func (v *verifier) failure() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.err
}

func (v *verifier) Close() error { return v.r.Close() }

func sha256Digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}
