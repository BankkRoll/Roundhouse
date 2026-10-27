//go:build integration

package imagepush

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	agentruntime "github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Integration fixtures. itHtpasswd is testUser's bcrypt (cost 4) entry for
// itPass.
const (
	itSrcRepo  = "prj_it/svc_it"
	itRepo     = "acct_it/rh-it"
	itTag      = "dep_it"
	itPass     = "it-push-p4ss-9f3c1e7a"
	itHtpasswd = testUser + ":$2a$04$oVfqr1P2ktUCTraXtYIE/OnX25MjdQfAGiVZu.GwIQrPuEoHmMX9e"
)

// startRegistry runs a registry:3 on network and returns its host:port once
// it answers. A non-empty htpasswd turns on Basic authentication.
func startRegistry(t *testing.T, c *docker.Client, network, htpasswd string) string {
	t.Helper()
	spec := docker.ContainerCreate{
		Image:      agentruntime.RegistryImage,
		Env:        []string{"REGISTRY_HTTP_ADDR=0.0.0.0:5000", "OTEL_TRACES_EXPORTER=none"},
		HostConfig: docker.HostConfig{NetworkMode: network},
	}
	if htpasswd != "" {
		spec.Env = append(spec.Env, "HTPASSWD="+htpasswd, "REGISTRY_AUTH=htpasswd",
			"REGISTRY_AUTH_HTPASSWD_REALM=roundhouse-it", "REGISTRY_AUTH_HTPASSWD_PATH=/tmp/htpasswd")
		spec.Entrypoint = []string{"/bin/sh", "-c"}
		spec.Cmd = []string{`printf '%s\n' "$HTPASSWD" > /tmp/htpasswd && exec registry serve /etc/distribution/config.yml`}
	}
	id := dockertest.Run(t, c, dockertest.Unique("roundhouse-it-push-"), spec)
	addr := dockertest.IP(t, c, id, network) + ":5000"
	dockertest.Eventually(t, 30*time.Second, "registry "+addr, func() bool {
		resp, err := http.Get("http://" + addr + "/v2/")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized
	})
	return addr
}

// itUpload pushes content to a registry with the monolithic upload.
func itUpload(t *testing.T, addr, repo string, content []byte) string {
	t.Helper()
	d := sha256Digest(content)
	resp, err := http.Post("http://"+addr+"/v2/"+repo+"/blobs/uploads/", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	loc, err := resp.Request.URL.Parse(resp.Header.Get("Location"))
	if resp.StatusCode != http.StatusAccepted || err != nil {
		t.Fatalf("start upload: HTTP %d", resp.StatusCode)
	}
	q := loc.Query()
	q.Set("digest", d)
	loc.RawQuery = q.Encode()
	req, _ := http.NewRequest(http.MethodPut, loc.String(), bytes.NewReader(content))
	if resp, err = http.DefaultClient.Do(req); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: HTTP %d", resp.StatusCode)
	}
	return d
}

func itPutManifest(t *testing.T, addr, repo, ref, mt string, body []byte) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, "http://"+addr+"/v2/"+repo+"/manifests/"+ref, bytes.NewReader(body))
	req.Header.Set("Content-Type", mt)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("put manifest: HTTP %d: %s", resp.StatusCode, b)
	}
	return sha256Digest(body)
}

// itImage stores a two-platform image (one gzipped layer each) in the
// registry at addr and returns the index digest and the amd64 manifest.
func itImage(t *testing.T, addr, repo string) (index, amd64 string, amd64Body []byte) {
	t.Helper()
	var entries []map[string]any
	for _, arch := range []string{"arm64", "amd64"} {
		var raw bytes.Buffer
		tw := tar.NewWriter(&raw)
		content := []byte("hello from " + arch + "\n")
		_ = tw.WriteHeader(&tar.Header{Name: "hello.txt", Mode: 0o644, Size: int64(len(content)), ModTime: time.Unix(0, 0)})
		_, _ = tw.Write(content)
		_ = tw.Close()
		var gz bytes.Buffer
		zw := gzip.NewWriter(&gz)
		_, _ = zw.Write(raw.Bytes())
		_ = zw.Close()
		layer := itUpload(t, addr, repo, gz.Bytes())
		config, _ := json.Marshal(map[string]any{
			"architecture": arch, "os": "linux",
			"config": map[string]any{"Cmd": []string{"/hello"}},
			"rootfs": map[string]any{"type": "layers", "diff_ids": []string{sha256Digest(raw.Bytes())}},
		})
		cd := itUpload(t, addr, repo, config)
		body, _ := json.Marshal(map[string]any{
			"schemaVersion": 2, "mediaType": mediaOCIManifest,
			"config": map[string]any{"mediaType": "application/vnd.oci.image.config.v1+json", "digest": cd, "size": len(config)},
			"layers": []map[string]any{{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": layer, "size": gz.Len()}},
		})
		md := itPutManifest(t, addr, repo, sha256Digest(body), mediaOCIManifest, body)
		if arch == "amd64" {
			amd64, amd64Body = md, body
		}
		entries = append(entries, map[string]any{"mediaType": mediaOCIManifest, "digest": md, "size": len(body),
			"platform": map[string]string{"os": "linux", "architecture": arch}})
	}
	body, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": mediaOCIIndex, "manifests": entries})
	return itPutManifest(t, addr, repo, "bld_1", mediaOCIIndex, body), amd64, amd64Body
}

func TestIntegrationPushToAuthenticatedRegistry(t *testing.T) {
	c := dockertest.Client(t)
	network := dockertest.Unique("roundhouse-it-push-")
	dockertest.Network(t, c, network, nil)
	dockertest.Attach(t, c, network)
	srcAddr := startRegistry(t, c, network, "")
	dstAddr := startRegistry(t, c, network, itHtpasswd)
	index, amd64, amd64Body := itImage(t, srcAddr, itSrcRepo)

	key := sealtest.Key()
	var logs syncBuffer
	results := make(chan *protocol.ImagePushResult, 2)
	p := New(Options{
		NodeID: testNode, Key: key, Builder: true,
		Send: func(_ context.Context, r *protocol.ImagePushResult) error {
			if err := r.Validate(); err != nil {
				t.Errorf("invalid result %+v: %v", r, err)
			}
			results <- r
			return nil
		},
		Logger:         slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		SourceAddr:     srcAddr,
		PlainHTTPHosts: []string{dstAddr},
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = p.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	push := func(pushID string) *protocol.ImagePushResult {
		pt, _ := json.Marshal(protocol.SealedImagePushCredential{Username: testUser, Password: itPass})
		box, err := protocol.SealBox(key.PublicKey(), pt, protocol.BoxPurposeImagePush, protocol.ImagePushAAD(testNode, pushID))
		if err != nil {
			t.Fatal(err)
		}
		p.PushImage(&protocol.ImagePush{
			Type: protocol.TypeImagePush, PushID: pushID,
			Source:   protocol.RegistryListen + "/" + itSrcRepo + "@" + index,
			Target:   dstAddr + "/" + itRepo + ":" + itTag,
			Platform: protocol.ImagePushPlatformAMD64, CredentialSealed: *box, TimeoutS: 120,
		})
		select {
		case r := <-results:
			return r
		case <-time.After(2 * time.Minute):
			t.Fatal("no result")
			return nil
		}
	}

	r := push("psh_it1")
	if !r.OK || r.Digest != amd64 || r.Bytes == nil || *r.Bytes == 0 {
		t.Fatalf("result %+v, want ok with digest %s", r, amd64)
	}

	req, _ := http.NewRequest(http.MethodGet, "http://"+dstAddr+"/v2/"+itRepo+"/manifests/"+itTag, nil)
	req.Header.Set("Accept", manifestAccept)
	req.SetBasicAuth(testUser, itPass)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, amd64Body) || resp.Header.Get("Docker-Content-Digest") != amd64 {
		t.Fatalf("target manifest: HTTP %d, digest %s, body %s", resp.StatusCode, resp.Header.Get("Docker-Content-Digest"), body)
	}

	again := push("psh_it2")
	if !again.OK || again.Digest != amd64 || again.Bytes == nil || *again.Bytes != 0 {
		t.Errorf("second push %+v, want ok with no bytes uploaded", again)
	}

	if bytes.Contains([]byte(logs.String()), []byte(itPass)) {
		t.Error("the password appears in the logs")
	}
}
