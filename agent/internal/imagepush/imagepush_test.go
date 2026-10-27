package imagepush

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	testNode = "node_test"
	testUser = "pushuser"
	testPass = "s3cret-push-password-0f9e"
)

// -----------------------------------------------------------------------------
// Fake registry
// -----------------------------------------------------------------------------

type storedManifest struct {
	body []byte
	mt   string
}

// fakeRegistry is an in-memory OCI distribution registry.
type fakeRegistry struct {
	t   *testing.T
	srv *httptest.Server

	mu        sync.Mutex
	manifests map[string]storedManifest // repo + "@" + digest or ":" + tag
	blobs     map[string][]byte
	// user and pass, when set, are required as Basic credentials or, with
	// bearer, as the token endpoint's login.
	user, pass string
	bearer     bool
	token      string
	tokenSrv   *httptest.Server
	tokenReqs  []url.Values
	// corrupt serves other bytes for a blob GET.
	corrupt map[string][]byte
	// redirectHEAD sends blob HEADs to this base URL.
	redirectHEAD string
	// absoluteLocation answers an upload POST with an absolute Location.
	absoluteLocation bool
	// gate, if set, blocks manifest and blob GETs until it is closed.
	gate     chan struct{}
	hang     bool
	requests []string
	uploaded []string
}

func newRegistry(t *testing.T) *fakeRegistry {
	r := &fakeRegistry{t: t, manifests: map[string]storedManifest{}, blobs: map[string][]byte{}, corrupt: map[string][]byte{}}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *fakeRegistry) host() string { return strings.TrimPrefix(r.srv.URL, "http://") }

func (r *fakeRegistry) withBasic() *fakeRegistry {
	r.user, r.pass = testUser, testPass
	return r
}

func (r *fakeRegistry) withBearer() *fakeRegistry {
	r.user, r.pass, r.bearer = testUser, testPass, true
	r.token = "tok-" + randomHex(8)
	r.tokenSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.tokenReqs = append(r.tokenReqs, req.URL.Query())
		r.mu.Unlock()
		if u, p, ok := req.BasicAuth(); !ok || u != r.user || p != r.pass {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": r.token})
	}))
	r.t.Cleanup(r.tokenSrv.Close)
	return r
}

func (r *fakeRegistry) authorized(req *http.Request) bool {
	if r.user == "" {
		return true
	}
	if r.bearer {
		return req.Header.Get("Authorization") == "Bearer "+r.token
	}
	u, p, ok := req.BasicAuth()
	return ok && u == r.user && p == r.pass
}

func (r *fakeRegistry) serve(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	r.requests = append(r.requests, req.Method+" "+req.URL.Path)
	gate, hang := r.gate, r.hang
	r.mu.Unlock()
	if !r.authorized(req) {
		if r.bearer {
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fake",scope="repository:x:pull"`, r.tokenSrv.URL))
		} else {
			w.Header().Set("WWW-Authenticate", `Basic realm="fake"`)
		}
		// Echoes the login it was sent, as a careless registry might.
		msg := "rejected " + req.Header.Get("Authorization")
		if u, p, ok := req.BasicAuth(); ok {
			msg += " (" + u + ":" + p + ")"
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"errors": []map[string]string{{"code": "UNAUTHORIZED", "message": msg}}})
		return
	}
	if req.URL.Path == "/v2/" {
		return
	}
	rest, ok := strings.CutPrefix(req.URL.Path, "/v2/")
	if !ok {
		http.NotFound(w, req)
		return
	}
	if (req.Method == http.MethodGet) && gate != nil {
		select {
		case <-gate:
		case <-req.Context().Done():
			return
		}
	}
	if hang && req.Method == http.MethodGet && strings.Contains(rest, "/blobs/") {
		<-req.Context().Done()
		return
	}
	switch {
	case strings.Contains(rest, "/blobs/uploads/"):
		repo, id, _ := strings.Cut(rest, "/blobs/uploads/")
		r.upload(w, req, repo, id)
	case strings.Contains(rest, "/manifests/"):
		repo, ref, _ := strings.Cut(rest, "/manifests/")
		r.manifest(w, req, repo, ref)
	case strings.Contains(rest, "/blobs/"):
		_, digest, _ := strings.Cut(rest, "/blobs/")
		r.blob(w, req, digest)
	default:
		http.NotFound(w, req)
	}
}

func refKey(repo, ref string) string {
	if strings.HasPrefix(ref, "sha256:") {
		return repo + "@" + ref
	}
	return repo + ":" + ref
}

func (r *fakeRegistry) manifest(w http.ResponseWriter, req *http.Request, repo, ref string) {
	switch req.Method {
	case http.MethodGet, http.MethodHead:
		r.mu.Lock()
		m, ok := r.manifests[refKey(repo, ref)]
		r.mu.Unlock()
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Type", m.mt)
		w.Header().Set("Docker-Content-Digest", sha256Digest(m.body))
		_, _ = w.Write(m.body)
	case http.MethodPut:
		body, _ := io.ReadAll(req.Body)
		r.put(repo, ref, body, req.Header.Get("Content-Type"))
		w.Header().Set("Docker-Content-Digest", sha256Digest(body))
		w.WriteHeader(http.StatusCreated)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (r *fakeRegistry) put(repo, ref string, body []byte, mt string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := storedManifest{body: body, mt: mt}
	r.manifests[refKey(repo, ref)] = m
	r.manifests[repo+"@"+sha256Digest(body)] = m
}

func (r *fakeRegistry) blob(w http.ResponseWriter, req *http.Request, digest string) {
	if req.Method == http.MethodHead && r.redirectHEAD != "" {
		http.Redirect(w, req, r.redirectHEAD+req.URL.Path, http.StatusTemporaryRedirect)
		return
	}
	r.mu.Lock()
	b, ok := r.blobs[digest]
	if c, bad := r.corrupt[digest]; bad {
		b = c
	}
	r.mu.Unlock()
	if !ok {
		http.NotFound(w, req)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	if req.Method == http.MethodGet {
		_, _ = w.Write(b)
	}
}

func (r *fakeRegistry) upload(w http.ResponseWriter, req *http.Request, repo, id string) {
	switch {
	case req.Method == http.MethodPost && id == "":
		loc := "/v2/" + repo + "/blobs/uploads/" + randomHex(8) + "?state=abc"
		if r.absoluteLocation {
			loc = r.srv.URL + loc
		}
		w.Header().Set("Location", loc)
		w.WriteHeader(http.StatusAccepted)
	case req.Method == http.MethodPut && id != "":
		if req.URL.Query().Get("state") != "abc" {
			http.Error(w, "lost the upload state", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(req.Body)
		if err != nil {
			return
		}
		digest := req.URL.Query().Get("digest")
		if sha256Digest(body) != digest {
			http.Error(w, "digest invalid", http.StatusBadRequest)
			return
		}
		r.mu.Lock()
		r.blobs[digest] = body
		r.uploaded = append(r.uploaded, digest)
		r.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (r *fakeRegistry) has(repo, ref string) (storedManifest, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.manifests[refKey(repo, ref)]
	return m, ok
}

func (r *fakeRegistry) count(prefix string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, s := range r.requests {
		if strings.HasPrefix(s, prefix) {
			n++
		}
	}
	return n
}

// -----------------------------------------------------------------------------
// Test images
// -----------------------------------------------------------------------------

type testImage struct {
	config, layer []byte
	manifest      []byte
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func desc(mt string, b []byte) map[string]any {
	return map[string]any{"mediaType": mt, "digest": sha256Digest(b), "size": len(b)}
}

// addImage stores a single-platform image in r and returns it.
func (r *fakeRegistry) addImage(repo, arch string) testImage {
	img := testImage{
		config: []byte(fmt.Sprintf(`{"architecture":%q,"os":"linux","rootfs":{"type":"layers","diff_ids":[]},"n":%q}`, arch, randomHex(4))),
		layer:  []byte("layer-" + arch + "-" + randomHex(64)),
	}
	img.manifest, _ = json.Marshal(map[string]any{
		"schemaVersion": 2,
		"mediaType":     mediaOCIManifest,
		"config":        desc("application/vnd.oci.image.config.v1+json", img.config),
		"layers":        []any{desc("application/vnd.oci.image.layer.v1.tar+gzip", img.layer)},
	})
	r.mu.Lock()
	r.blobs[sha256Digest(img.config)] = img.config
	r.blobs[sha256Digest(img.layer)] = img.layer
	r.mu.Unlock()
	r.put(repo, sha256Digest(img.manifest), img.manifest, mediaOCIManifest)
	return img
}

// addIndex stores an index over imgs (keyed by architecture) and returns
// its digest.
func (r *fakeRegistry) addIndex(repo string, imgs map[string]testImage) string {
	var ms []any
	for _, arch := range []string{"arm64", "amd64"} {
		img, ok := imgs[arch]
		if !ok {
			continue
		}
		d := desc(mediaOCIManifest, img.manifest)
		d["platform"] = map[string]string{"os": "linux", "architecture": arch}
		ms = append(ms, d)
	}
	body, _ := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": mediaOCIIndex, "manifests": ms})
	r.put(repo, sha256Digest(body), body, mediaOCIIndex)
	return sha256Digest(body)
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

type harness struct {
	t       *testing.T
	p       *Pusher
	results chan *protocol.ImagePushResult
	logs    *syncBuffer
	mu      sync.Mutex
	lines   []string
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func newHarness(t *testing.T, src *fakeRegistry, tweak func(*Options), plain ...string) *harness {
	leaktest.Check(t)
	h := &harness{t: t, results: make(chan *protocol.ImagePushResult, 16), logs: &syncBuffer{}}
	opts := Options{
		NodeID:  testNode,
		Key:     sealtest.Key(),
		Builder: true,
		Send: func(_ context.Context, r *protocol.ImagePushResult) error {
			if err := r.Validate(); err != nil {
				t.Errorf("invalid result: %v", err)
			}
			h.results <- r
			return nil
		},
		Log: func(pushID string, _ protocol.LogStream, text string) {
			h.mu.Lock()
			h.lines = append(h.lines, text)
			h.mu.Unlock()
		},
		Logger:         slog.New(slog.NewTextHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		PlainHTTPHosts: plain,
	}
	if src != nil {
		opts.SourceAddr = src.host()
	}
	if tweak != nil {
		tweak(&opts)
	}
	h.p = New(opts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.p.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return h
}

func pushMsg(t *testing.T, pushID, repo, digest, target string, timeoutS int) *protocol.ImagePush {
	t.Helper()
	pt, _ := json.Marshal(protocol.SealedImagePushCredential{Username: testUser, Password: testPass})
	box, err := protocol.SealBox(sealtest.Key().PublicKey(), pt, protocol.BoxPurposeImagePush, protocol.ImagePushAAD(testNode, pushID))
	if err != nil {
		t.Fatal(err)
	}
	return &protocol.ImagePush{
		Type: protocol.TypeImagePush, PushID: pushID,
		Source:   protocol.RegistryListen + "/" + repo + "@" + digest,
		Target:   target,
		Platform: protocol.ImagePushPlatformAMD64, CredentialSealed: *box, TimeoutS: timeoutS,
	}
}

func (h *harness) result() *protocol.ImagePushResult {
	h.t.Helper()
	select {
	case r := <-h.results:
		return r
	case <-time.After(20 * time.Second):
		h.t.Fatal("no image_push_result")
		return nil
	}
}

func (h *harness) noResult(d time.Duration) {
	h.t.Helper()
	select {
	case r := <-h.results:
		h.t.Fatalf("unexpected result %+v", r)
	case <-time.After(d):
	}
}

// assertNoSecret fails if the login or anything derived from it reached a
// result, a log or a progress line.
func (h *harness) assertNoSecret(r *protocol.ImagePushResult, extra ...string) {
	h.t.Helper()
	h.mu.Lock()
	lines := strings.Join(h.lines, "\n")
	h.mu.Unlock()
	secrets := append([]string{testPass, base64.StdEncoding.EncodeToString([]byte(testUser + ":" + testPass))}, extra...)
	for _, s := range secrets {
		for name, text := range map[string]string{"result": r.Error, "log": h.logs.String(), "progress": lines} {
			if strings.Contains(text, s) {
				h.t.Errorf("%s contains a secret %q:\n%s", name, s, text)
			}
		}
	}
}

func expectOK(t *testing.T, r *protocol.ImagePushResult, digest string, bytes int64) {
	t.Helper()
	if !r.OK || r.Error != "" {
		t.Fatalf("push failed: %q", r.Error)
	}
	if r.Digest != digest {
		t.Errorf("digest = %s, want %s", r.Digest, digest)
	}
	if r.Bytes == nil || *r.Bytes != bytes {
		t.Errorf("bytes = %v, want %d", r.Bytes, bytes)
	}
}

func expectError(t *testing.T, r *protocol.ImagePushResult, want string) {
	t.Helper()
	if r.OK || !strings.Contains(r.Error, want) {
		t.Fatalf("result = ok %v, error %q; want an error containing %q", r.OK, r.Error, want)
	}
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

func TestImagePushSelectsAMD64FromIndex(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t).withBasic()
	amd, arm := src.addImage("prj_a/svc_b", "amd64"), src.addImage("prj_a/svc_b", "arm64")
	idx := src.addIndex("prj_a/svc_b", map[string]testImage{"amd64": amd, "arm64": arm})
	h := newHarness(t, src, nil, dst.host())

	h.p.PushImage(pushMsg(t, "push_1", "prj_a/svc_b", idx, dst.host()+"/acct/rh-app:dep_1", 60))
	r := h.result()
	expectOK(t, r, sha256Digest(amd.manifest), int64(len(amd.config)+len(amd.layer)))
	m, ok := dst.has("acct/rh-app", "dep_1")
	if !ok || !bytes.Equal(m.body, amd.manifest) || m.mt != mediaOCIManifest {
		t.Fatalf("target manifest = %q (%s), want the amd64 manifest's exact bytes", m.body, m.mt)
	}
	if _, ok := dst.blobs[sha256Digest(arm.layer)]; ok {
		t.Error("the arm64 layer was uploaded")
	}
	h.assertNoSecret(r)
}

func TestImagePushSingleManifest(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t)
	dst.absoluteLocation = true
	img := src.addImage("r", "amd64")
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	expectOK(t, h.result(), sha256Digest(img.manifest), int64(len(img.config)+len(img.layer)))
}

func TestImagePushWithoutAMD64(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t)
	arm := src.addImage("r", "arm64")
	idx := src.addIndex("r", map[string]testImage{"arm64": arm})
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", idx, dst.host()+"/acct/app:t1", 60))
	expectError(t, h.result(), "the image has no linux/amd64 variant")
	if n := dst.count("PUT"); n != 0 {
		t.Errorf("%d PUTs reached the target", n)
	}
}

func TestImagePushSkipsBlobsTheTargetHas(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t).withBasic()
	img := src.addImage("r", "amd64")
	dst.blobs[sha256Digest(img.layer)] = img.layer
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	expectOK(t, h.result(), sha256Digest(img.manifest), int64(len(img.config)))
	if len(dst.uploaded) != 1 || dst.uploaded[0] != sha256Digest(img.config) {
		t.Errorf("uploaded = %v, want only the config", dst.uploaded)
	}
}

func TestImagePushAbortsOnDigestMismatch(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t)
	img := src.addImage("r", "amd64")
	bad := bytes.Clone(img.layer)
	bad[len(bad)-1] ^= 1
	src.corrupt[sha256Digest(img.layer)] = bad
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	expectError(t, h.result(), "push aborted")
	if _, ok := dst.blobs[sha256Digest(img.layer)]; ok {
		t.Error("the corrupt layer reached the target")
	}
	if _, ok := dst.has("acct/app", "t1"); ok {
		t.Error("the manifest was pushed")
	}
}

func TestImagePushBearerTokenFlow(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t).withBearer()
	img := src.addImage("r", "amd64")
	tokenHost := strings.TrimPrefix(dst.tokenSrv.URL, "http://")
	h := newHarness(t, src, nil, dst.host(), tokenHost)
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	r := h.result()
	expectOK(t, r, sha256Digest(img.manifest), int64(len(img.config)+len(img.layer)))
	dst.mu.Lock()
	reqs := dst.tokenReqs
	dst.mu.Unlock()
	if len(reqs) == 0 {
		t.Fatal("the token endpoint was not asked")
	}
	if q := reqs[0]; q.Get("service") != "fake" || !strings.Contains(strings.Join(q["scope"], " "), "repository:acct/app:pull,push") {
		t.Errorf("token request = %v", q)
	}
	h.assertNoSecret(r, dst.token)
}

func TestImagePushRefusesPlainHTTPTokenRealm(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t).withBearer()
	img := src.addImage("r", "amd64")
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	expectError(t, h.result(), "token realm that is not https")
	if len(dst.tokenReqs) != 0 {
		t.Error("the login was sent to a plain http realm")
	}
}

func TestImagePushRejectedCredentialNeverLeaks(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t).withBasic()
	dst.pass = "a-different-password"
	img := src.addImage("r", "amd64")
	h := newHarness(t, src, nil, dst.host())
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	r := h.result()
	expectError(t, r, "credential was rejected")
	if !strings.Contains(r.Error, "[redacted]") {
		t.Errorf("error = %q; the echoed login should be redacted", r.Error)
	}
	h.assertNoSecret(r)
}

func TestImagePushDropsAuthorizationOnRedirectToAnotherHost(t *testing.T) {
	var sawAuth atomic.Value
	sawAuth.Store("")
	var hits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if a := r.Header.Get("Authorization"); a != "" {
			sawAuth.Store(a)
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(other.Close)
	src, dst := newRegistry(t), newRegistry(t).withBasic()
	dst.redirectHEAD = other.URL
	img := src.addImage("r", "amd64")
	h := newHarness(t, src, nil, dst.host(), strings.TrimPrefix(other.URL, "http://"))
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60))
	expectOK(t, h.result(), sha256Digest(img.manifest), int64(len(img.config)+len(img.layer)))
	if hits.Load() == 0 {
		t.Fatal("the redirect was not followed")
	}
	if a := sawAuth.Load().(string); a != "" {
		t.Errorf("the redirected host received Authorization %q", a)
	}
}

func TestCheckRedirectRefusesDowngrade(t *testing.T) {
	first, _ := http.NewRequest(http.MethodGet, "https://reg.example/v2/a/blobs/sha256:x", nil)
	next, _ := http.NewRequest(http.MethodGet, "http://storage.example/blob", nil)
	next.Header.Set("Authorization", "Basic abc")
	if err := checkRedirect(next, []*http.Request{first}); err == nil || !strings.Contains(err.Error(), "refusing a redirect") {
		t.Fatalf("err = %v", err)
	}
	same, _ := http.NewRequest(http.MethodGet, "https://reg.example/v2/other", nil)
	same.Header.Set("Authorization", "Basic abc")
	if err := checkRedirect(same, []*http.Request{first}); err != nil || same.Header.Get("Authorization") == "" {
		t.Fatalf("same-host redirect: err %v, authorization %q", err, same.Header.Get("Authorization"))
	}
}

func TestImagePushTimeout(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t)
	img := src.addImage("r", "amd64")
	src.hang = true
	h := newHarness(t, src, nil, dst.host())
	m := pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 1)
	start := time.Now()
	h.p.PushImage(m)
	expectError(t, h.result(), "did not finish within 1 s")
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("the push took %v", d)
	}
}

func TestImagePushRepeatedPushID(t *testing.T) {
	src, dst := newRegistry(t), newRegistry(t)
	img := src.addImage("r", "amd64")
	src.gate = make(chan struct{})
	h := newHarness(t, src, nil, dst.host())
	m := pushMsg(t, "push_1", "r", sha256Digest(img.manifest), dst.host()+"/acct/app:t1", 60)
	h.p.PushImage(m)
	h.p.PushImage(m)
	h.noResult(200 * time.Millisecond)
	close(src.gate)
	first := h.result()
	expectOK(t, first, sha256Digest(img.manifest), int64(len(img.config)+len(img.layer)))
	h.noResult(200 * time.Millisecond)
	if n := src.count("GET /v2/r/manifests/"); n != 1 {
		t.Errorf("the source manifest was read %d times", n)
	}

	h.p.PushImage(m)
	again := h.result()
	if again.Digest != first.Digest || *again.Bytes != *first.Bytes {
		t.Errorf("repeated result = %+v, want %+v", again, first)
	}
	if n := src.count("GET /v2/r/manifests/"); n != 1 {
		t.Errorf("a repeated push_id pushed again (%d manifest reads)", n)
	}
}

func TestImagePushRemembersBoundedResults(t *testing.T) {
	h := newHarness(t, nil, func(o *Options) { o.Builder = false })
	for i := range remembered + 10 {
		h.p.PushImage(pushMsg(t, fmt.Sprintf("push_%d", i), "r", sha256Digest(nil), "reg.example/a:b", 60))
		h.result()
	}
	h.p.mu.Lock()
	n, f := len(h.p.pushes), len(h.p.finished)
	h.p.mu.Unlock()
	if n != remembered || f != remembered {
		t.Errorf("remembered %d results (%d finished), want %d", n, f, remembered)
	}
}

func TestImagePushRefusals(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tweak func(*Options)
		want  string
	}{
		{"not a builder", func(o *Options) { o.Builder = false }, NotBuilder},
		{"plaintext connection", func(o *Options) { o.Refusal = "credential-bearing work is refused over ws://" }, "refused over ws://"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := newRegistry(t)
			img := src.addImage("r", "amd64")
			h := newHarness(t, src, tc.tweak)
			h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), "reg.example/a:b", 60))
			r := h.result()
			if r.OK || !strings.Contains(r.Error, tc.want) {
				t.Fatalf("result = %+v", r)
			}
			if n := src.count(""); n != 0 {
				t.Errorf("%d requests reached the source", n)
			}
		})
	}
}

func TestImagePushWrongKey(t *testing.T) {
	src := newRegistry(t)
	img := src.addImage("r", "amd64")
	h := newHarness(t, src, func(o *Options) { o.Key = sealtest.OtherKey(t) })
	h.p.PushImage(pushMsg(t, "push_1", "r", sha256Digest(img.manifest), "reg.example/a:b", 60))
	r := h.result()
	expectError(t, r, "open the registry credential")
	h.assertNoSecret(r)
}

func TestParseChallenges(t *testing.T) {
	got := parseChallenges(`Bearer realm="https://auth.example/token",service="reg",scope="repository:a:pull,push", Basic realm="x\"y"`)
	if len(got) != 2 || got[0].scheme != "bearer" || got[0].params["realm"] != "https://auth.example/token" ||
		got[0].params["scope"] != "repository:a:pull,push" || got[1].scheme != "basic" || got[1].params["realm"] != `x"y` {
		t.Fatalf("got %+v", got)
	}
}

func TestTruncate(t *testing.T) {
	s := strings.Repeat("é", 3000)
	got := truncate(s, protocol.MaxMessageBytes)
	if len(got) > protocol.MaxMessageBytes || !strings.HasSuffix(got, "…") {
		t.Fatalf("len %d", len(got))
	}
	if truncate("short", 10) != "short" {
		t.Fatal("short string changed")
	}
}
