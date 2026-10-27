package runtime

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const testNode = "node_1"

func sealedHarness(t *testing.T, tweak func(*Options)) *harness {
	return newHarness(t, func(o *Options) {
		o.OpenEnv = sealtest.Opener(sealtest.Key(), testNode)
		if tweak != nil {
			tweak(o)
		}
	})
}

// sealed returns w with env and files sealed to the test key for gen.
func sealed(t *testing.T, w protocol.WorkloadSpec, gen int64, env, files map[string]string) protocol.WorkloadSpec {
	sealtest.SealWorkload(t, sealtest.Key().PublicKey(), testNode, gen, &w, env, files)
	return w
}

func (h *harness) report(id string) protocol.WorkloadStatusReport {
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == id {
			return s
		}
	}
	return protocol.WorkloadStatusReport{}
}

func (h *harness) waitPending(id, contains string) protocol.WorkloadStatusReport {
	h.t.Helper()
	var r protocol.WorkloadStatusReport
	eventually(h.t, id+" pending with "+contains, func() bool {
		r = h.report(id)
		return r.State == protocol.StatePending && strings.Contains(r.Message, contains)
	})
	if n := len(h.d.byWorkload(id)); n != 0 {
		h.t.Fatalf("%d containers created for a blocked workload", n)
	}
	return r
}

func TestSealedEnvReachesTheContainer(t *testing.T) {
	h := sealedHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, sealed(t, w, 1, map[string]string{"GREETING": "sealed"}, nil)))
	c := h.running("wl_a")
	if !slices.Equal(c.spec.Env, []string{"GREETING=sealed"}) {
		t.Fatalf("env %v", c.spec.Env)
	}
	if len(c.spec.HostConfig.Binds) != 0 {
		t.Fatalf("binds %v without secret files", c.spec.HostConfig.Binds)
	}

	// The next generation re-seals the same environment; the container,
	// whose spec is unchanged, keeps running.
	h.rt.Apply(desired(2, sealed(t, w, 2, map[string]string{"GREETING": "sealed"}, nil)))
	h.waitState("wl_a", protocol.StateHealthy)
	if n := len(h.d.byWorkload("wl_a")); n != 1 {
		t.Fatalf("%d containers after a re-seal", n)
	}
}

func TestBoxThatDoesNotOpenLeavesWorkloadPending(t *testing.T) {
	for name, tc := range map[string]struct {
		seal     func(t *testing.T, w protocol.WorkloadSpec) protocol.WorkloadSpec
		contains string
	}{
		"wrong key": {func(t *testing.T, w protocol.WorkloadSpec) protocol.WorkloadSpec {
			sealtest.SealWorkload(t, sealtest.OtherKey(t).PublicKey(), testNode, 1, &w, map[string]string{"A": "b"}, nil)
			return w
		}, "re-join the node"},
		"other generation": {func(t *testing.T, w protocol.WorkloadSpec) protocol.WorkloadSpec {
			return sealed(t, w, 7, map[string]string{"A": "b"}, nil)
		}, "decryption failed"},
		"other node": {func(t *testing.T, w protocol.WorkloadSpec) protocol.WorkloadSpec {
			sealtest.SealWorkload(t, sealtest.Key().PublicKey(), "node_2", 1, &w, map[string]string{"A": "b"}, nil)
			return w
		}, "decryption failed"},
		"missing box": {func(_ *testing.T, w protocol.WorkloadSpec) protocol.WorkloadSpec {
			w.EnvSealed, w.Env = nil, nil
			return w
		}, "missing"},
	} {
		t.Run(name, func(t *testing.T) {
			h := sealedHarness(t, nil)
			w := spec("wl_a", "svc_web")
			h.rt.Apply(desired(1, tc.seal(t, w)))
			h.waitPending("wl_a", tc.contains)
		})
	}
}

func TestWrongKeyIsReportedDistinctly(t *testing.T) {
	if got := EnvFailure(errors.Join(errors.New("workload wl_a"), protocol.ErrBoxWrongKey)); !strings.Contains(got, "re-join") {
		t.Fatalf("wrong key message %q", got)
	}
	if got := EnvFailure(errors.New("sealed box: decryption failed")); strings.Contains(got, "re-join") {
		t.Fatalf("generic failure blames the key: %q", got)
	}
}

func TestRefusedWorkloadsNeverStart(t *testing.T) {
	other := protocol.EnvironmentNetworkName("prj_2", "env_1")
	for name, tc := range map[string]struct {
		mutate   func(*protocol.WorkloadSpec)
		contains string
	}{
		"host network":            {func(w *protocol.WorkloadSpec) { w.Network = "host" }, `refusing network "host"`},
		"bridge network":          {func(w *protocol.WorkloadSpec) { w.Network = "bridge" }, "refusing network"},
		"system network":          {func(w *protocol.WorkloadSpec) { w.Network = SystemNetwork }, "refusing network"},
		"build network":           {func(w *protocol.WorkloadSpec) { w.Network = "roundhouse-build" }, "refusing network"},
		"other project's network": {func(w *protocol.WorkloadSpec) { w.Network = other }, "refusing network"},
		"other environment's network": {func(w *protocol.WorkloadSpec) {
			w.Network = protocol.EnvironmentNetworkName("prj_1", "env_2")
		}, "refusing network"},
		"other service's image": {func(w *protocol.WorkloadSpec) {
			w.Image = protocol.LocalImageRepository("prj_1", "svc_other") + "@sha256:" + strings.Repeat("ab", 32)
		}, "refusing image"},
		"local image by tag": {func(w *protocol.WorkloadSpec) {
			w.Image = protocol.LocalImageRepository("prj_1", "svc_web") + ":latest"
		}, "refusing image"},
		"system kind": {func(w *protocol.WorkloadSpec) { w.Kind = protocol.WorkloadSystem }, "only service workloads"},
	} {
		t.Run(name, func(t *testing.T) {
			h := sealedHarness(t, nil)
			w := spec("wl_a", "svc_web")
			tc.mutate(&w)
			h.rt.Apply(desired(1, sealed(t, rehash(w), 1, nil, nil)))
			h.waitPending("wl_a", tc.contains)
			h.d.mu.Lock()
			defer h.d.mu.Unlock()
			for n := range h.d.networks {
				if n != protocol.EnvironmentNetworkName("prj_1", "env_1") {
					t.Fatalf("created network %q for a refused workload", n)
				}
			}
		})
	}
}

func TestLegacyProjectNetworkStillAccepted(t *testing.T) {
	h := sealedHarness(t, nil)
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	w.Network = protocol.ProjectNetworkName("prj_1")
	h.rt.Apply(desired(1, sealed(t, rehash(w), 1, nil, nil)))
	h.running("wl_a")
}

func TestPrivateImageIsAlwaysPulled(t *testing.T) {
	h := sealedHarness(t, nil)
	ref := "ghcr.io/acme/private@sha256:" + strings.Repeat("cd", 32)
	h.d.mu.Lock()
	h.d.addImageLocked(ref, 1)
	h.d.pullErr[ref] = errors.New("denied: requested access to the resource is denied")
	h.d.mu.Unlock()
	w := spec("wl_a", "svc_web")
	w.Image = ref
	w.RegistryAuth = &protocol.RegistryAuth{Server: "ghcr.io", Username: "u", Password: "p"}
	h.rt.Apply(desired(1, sealed(t, rehash(w), 1, nil, nil)))
	eventually(t, "crashed on the denied pull", func() bool {
		r := h.report("wl_a")
		return r.State == protocol.StateCrashed && strings.Contains(r.Message, "denied")
	})
	if n := len(h.d.byWorkload("wl_a")); n != 0 {
		t.Fatal("ran a cached private image whose pull was denied")
	}
	h.d.mu.Lock()
	delete(h.d.pullErr, ref)
	h.d.mu.Unlock()
	h.running("wl_a")
	h.d.mu.Lock()
	defer h.d.mu.Unlock()
	if p := h.d.pulls[0]; p.ref != ref || p.auth == nil || p.auth.Username != "u" {
		t.Fatalf("pull %+v", p)
	}
}

func TestSecretFilesAreMountedReadOnlyAndRemoved(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "secrets")
	h := sealedHarness(t, func(o *Options) { o.SecretsDir = dir })
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, sealed(t, w, 1,
		map[string]string{"PLAIN": "1"}, map[string]string{"API_KEY": "s3cret-value", "TLS_KEY": "-----BEGIN\nx\n"})))
	c := h.running("wl_a")
	if slices.ContainsFunc(c.spec.Env, func(e string) bool { return strings.Contains(e, "s3cret") }) {
		t.Fatalf("secret file value in env %v", c.spec.Env)
	}
	if !slices.Equal(c.spec.Env, []string{"PLAIN=1"}) {
		t.Fatalf("env %v", c.spec.Env)
	}
	wdir := filepath.Join(dir, "wl_a")
	if want := filepath.ToSlash(wdir) + ":/run/secrets:ro"; !slices.Equal(c.spec.HostConfig.Binds, []string{want}) {
		t.Fatalf("binds %v, want [%s]", c.spec.HostConfig.Binds, want)
	}
	for key, want := range map[string]string{"API_KEY": "s3cret-value", "TLS_KEY": "-----BEGIN\nx\n"} {
		got, err := os.ReadFile(filepath.Join(wdir, key))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", key, got, err)
		}
	}
	entries, _ := os.ReadDir(wdir)
	if len(entries) != 2 {
		t.Fatalf("stray files in the secrets directory: %v", entries)
	}
	if goruntime.GOOS != "windows" {
		for path, want := range map[string]fs.FileMode{dir: 0o700, wdir: 0o755, filepath.Join(wdir, "API_KEY"): 0o444} {
			if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != want {
				t.Errorf("%s mode %v, want %v (%v)", path, fi.Mode().Perm(), want, err)
			}
		}
	}

	h.rt.Apply(desired(2))
	eventually(t, "container and secret files removed", func() bool {
		_, err := os.Stat(wdir)
		return len(h.d.byWorkload("wl_a")) == 0 && errors.Is(err, fs.ErrNotExist)
	})
}

func TestSecretFilesNeedASecretsDir(t *testing.T) {
	h := sealedHarness(t, nil)
	w := spec("wl_a", "svc_web")
	h.rt.Apply(desired(1, sealed(t, w, 1, nil, map[string]string{"API_KEY": "s3cret-value"})))
	eventually(t, "crashed without a secrets directory", func() bool {
		r := h.report("wl_a")
		return r.State == protocol.StateCrashed && strings.Contains(r.Message, "secrets directory")
	})
}

func TestNetworksGetANamedBridgeAndFirewallHook(t *testing.T) {
	var seen []string
	h := sealedHarness(t, func(o *Options) {
		o.OnNetwork = func(_ context.Context, n docker.Network) { seen = append(seen, n.BridgeInterface()) }
	})
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, sealed(t, w, 1, nil, nil)))
	h.running("wl_a")
	want := BridgeInterface(w.Network)
	if len(want) > 15 || !strings.HasPrefix(want, "rh-") {
		t.Fatalf("bridge name %q", want)
	}
	h.d.mu.Lock()
	got := h.d.networks[w.Network].Options[docker.BridgeNameOption]
	h.d.mu.Unlock()
	if got != want {
		t.Fatalf("bridge option %q, want %q", got, want)
	}
	h.stop()
	if !slices.Equal(seen, []string{want}) {
		t.Fatalf("OnNetwork saw %v, want [%s] once", seen, want)
	}
}
