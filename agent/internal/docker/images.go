package docker

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// AuthConfig is a registry credential sent with a pull.
type AuthConfig struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// ServerAddress is the registry host, e.g. "ghcr.io".
	ServerAddress string `json:"serveraddress"`
}

// Reference is a parsed image reference.
type Reference struct {
	// Domain is the registry host, "docker.io" when the reference has none.
	Domain string
	// Repository is the reference without tag or digest, as written.
	Repository string
	// Tag is empty when the reference has none.
	Tag string
	// Digest is "sha256:…" when the reference pins one.
	Digest string
}

// ParseReference splits an image reference such as
// "ghcr.io/acme/api:1.2@sha256:…" into its parts. It does not validate the
// reference; the protocol layer already has.
func ParseReference(ref string) Reference {
	var r Reference
	if i := strings.Index(ref, "@"); i >= 0 {
		r.Digest = ref[i+1:]
		ref = ref[:i]
	}
	// A ':' after the last '/' is a tag; one before it is a registry port.
	if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
		r.Tag = ref[i+1:]
		ref = ref[:i]
	}
	r.Repository = ref
	r.Domain = "docker.io"
	if i := strings.Index(ref, "/"); i >= 0 {
		first := ref[:i]
		if strings.ContainsAny(first, ".:") || first == "localhost" {
			r.Domain = first
		}
	}
	return r
}

// SameRegistry reports whether two registry hosts name the same registry,
// treating Docker Hub's aliases as one.
func SameRegistry(a, b string) bool {
	return normalizeRegistry(a) == normalizeRegistry(b)
}

func normalizeRegistry(host string) string {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://"), "/"))
	switch host {
	case "docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com":
		return "docker.io"
	}
	return host
}

// PullProgress is one message of a pull's progress stream.
type PullProgress struct {
	Status      string `json:"status"`
	ID          string `json:"id"`
	Error       string `json:"error"`
	ErrorDetail *struct {
		Message string `json:"message"`
	} `json:"errorDetail"`
}

// PullImage pulls ref and blocks until the pull completes. auth may be nil.
// The engine reports pull failures inside a 200 response, so the progress
// stream is read to the end and its error message, if any, returned.
func (c *Client) PullImage(ctx context.Context, ref string, auth *AuthConfig) error {
	r := ParseReference(ref)
	q := url.Values{"fromImage": {r.Repository}}
	switch {
	case r.Digest != "":
		q.Set("tag", r.Digest)
	case r.Tag != "":
		q.Set("tag", r.Tag)
	default:
		// NOTE: an empty tag makes the engine pull every tag of the repository.
		q.Set("tag", "latest")
	}
	h := http.Header{}
	if auth != nil {
		data, err := json.Marshal(auth)
		if err != nil {
			return err
		}
		h.Set("X-Registry-Auth", base64.URLEncoding.EncodeToString(data))
	}
	body, err := c.openStream(ctx, request{method: http.MethodPost, path: "/images/create", query: q, header: h})
	if err != nil {
		return err
	}
	defer body.Close()
	return readPullStream(body)
}

func readPullStream(r io.Reader) error {
	dec := json.NewDecoder(bufio.NewReader(r))
	for {
		var p PullProgress
		if err := dec.Decode(&p); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("read pull progress: %w", err)
		}
		if p.ErrorDetail != nil && p.ErrorDetail.Message != "" {
			return errors.New(p.ErrorDetail.Message)
		}
		if p.Error != "" {
			return errors.New(p.Error)
		}
	}
}

// Image is the subset of an image inspect or list entry the agent uses.
type Image struct {
	ID          string            `json:"Id"`
	RepoTags    []string          `json:"RepoTags"`
	RepoDigests []string          `json:"RepoDigests"`
	Created     string            `json:"Created"`
	Size        int64             `json:"Size"`
	Labels      map[string]string `json:"Labels"`
}

// InspectImage returns the local image ref resolves to. It fails with an
// error satisfying [IsNotFound] when the image is not present.
func (c *Client) InspectImage(ctx context.Context, ref string) (Image, error) {
	var img Image
	err := c.do(ctx, request{method: http.MethodGet, path: "/images/" + escapeRef(ref) + "/json"}, &img)
	return img, err
}

// ImageSummary is one entry of an image list.
type ImageSummary struct {
	ID       string   `json:"Id"`
	RepoTags []string `json:"RepoTags"`
	// Created is unix seconds.
	Created    int64 `json:"Created"`
	Size       int64 `json:"Size"`
	Containers int64 `json:"Containers"`
}

// ListImages returns every top-level image.
func (c *Client) ListImages(ctx context.Context) ([]ImageSummary, error) {
	var imgs []ImageSummary
	err := c.do(ctx, request{method: http.MethodGet, path: "/images/json"}, &imgs)
	return imgs, err
}

// RemoveImage deletes an image by ID. It never forces, so the engine refuses
// to delete an image any container still uses.
func (c *Client) RemoveImage(ctx context.Context, id string) error {
	return c.do(ctx, request{method: http.MethodDelete, path: "/images/" + escapeRef(id)}, nil)
}

// escapeRef escapes a reference for use as one path segment. Slashes stay,
// since the engine routes "/images/{name:.*}/json".
func escapeRef(ref string) string {
	parts := strings.Split(ref, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}
