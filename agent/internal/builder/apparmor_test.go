package builder

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeEngine answers the Engine API calls AppArmor resolution makes. Starting
// a container fails unless its AppArmor profile is in loaded, as runc fails
// on a host where the profile is not loaded.
type fakeEngine struct {
	apparmor bool
	loaded   map[string]bool

	mu      sync.Mutex
	created map[string][]string // container name -> SecurityOpt
	started []string
	removed []string
	calls   int
}

func (e *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls++
	path := strings.TrimPrefix(r.URL.Path, "/"+dockerAPIVersion)
	switch {
	case r.Method == http.MethodGet && path == "/info":
		opts := []string{"name=seccomp,profile=builtin", "name=cgroupns"}
		if e.apparmor {
			opts = append([]string{"name=apparmor"}, opts...)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"SecurityOptions": opts})
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/"):
		_, _ = w.Write([]byte(`{}`))
	case r.Method == http.MethodPost && path == "/containers/create":
		var spec struct {
			HostConfig struct {
				SecurityOpt []string `json:"SecurityOpt"`
			} `json:"HostConfig"`
		}
		_ = json.NewDecoder(r.Body).Decode(&spec)
		name := r.URL.Query().Get("name")
		e.created[name] = spec.HostConfig.SecurityOpt
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": name})
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/start"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/start")
		for _, o := range e.created[id] {
			if p, ok := strings.CutPrefix(o, "apparmor="); ok && !e.loaded[p] {
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": "failed to create task for container: " +
					"unable to apply apparmor profile: apparmor failed to apply profile: " +
					"write /proc/thread-self/attr/apparmor/exec: no such file or directory"})
				return
			}
		}
		e.started = append(e.started, id)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
		id := strings.TrimPrefix(path, "/containers/")
		if _, ok := e.created[id]; !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"No such container"}`))
			return
		}
		delete(e.created, id)
		e.removed = append(e.removed, id)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unexpected "+r.Method+" "+path, http.StatusTeapot)
	}
}

// startFakeEngine serves e on a unix socket and returns a daemon using it.
func startFakeEngine(t *testing.T, e *fakeEngine) *daemon {
	t.Helper()
	e.created = map[string][]string{}
	// NOTE: unix socket paths are limited to ~100 bytes, which t.TempDir()
	// can exceed.
	dir, err := os.MkdirTemp("", "rh-aa")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	srv := &http.Server{Handler: e}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	api, err := newDockerAPI("unix://" + sock)
	if err != nil {
		t.Fatal(err)
	}
	return &daemon{docker: api, log: slog.New(slog.DiscardHandler), image: BuildKitImage}
}

// hostFiles points the host interfaces at fixtures; an empty profiles
// string means the list is unreadable, as inside a container.
func hostFiles(t *testing.T, profiles, restrict string) {
	t.Helper()
	dir := t.TempDir()
	oldProfiles, oldSysctl := appArmorProfilesPath, usernsRestrictSysctl
	t.Cleanup(func() { appArmorProfilesPath, usernsRestrictSysctl = oldProfiles, oldSysctl })
	appArmorProfilesPath = filepath.Join(dir, "profiles")
	usernsRestrictSysctl = filepath.Join(dir, "restrict")
	if profiles != "" {
		if err := os.WriteFile(appArmorProfilesPath, []byte(profiles), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if restrict != "" {
		if err := os.WriteFile(usernsRestrictSysctl, []byte(restrict+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAppArmorProfileResolution(t *testing.T) {
	const listed = "docker-default (enforce)\nroundhouse-buildkit (unconfined)\nunprivileged_userns (enforce)\n"
	const unlisted = "docker-default (enforce)\nroundhouse-buildkit-old (unconfined)\n"
	tests := []struct {
		name      string
		override  string
		apparmor  bool
		loaded    bool
		profiles  string
		want      string
		wantProbe bool
	}{
		{name: "override wins", override: "site-profile", apparmor: true, profiles: listed, want: "site-profile"},
		{name: "engine without AppArmor", apparmor: false, loaded: true, profiles: listed, want: "unconfined"},
		{name: "listed on this host", apparmor: true, profiles: listed, want: AppArmorProfile},
		{name: "not listed on this host", apparmor: true, loaded: true, profiles: unlisted, want: "unconfined"},
		{name: "probe succeeds", apparmor: true, loaded: true, want: AppArmorProfile, wantProbe: true},
		{name: "probe fails", apparmor: true, loaded: false, want: "unconfined", wantProbe: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hostFiles(t, tt.profiles, "1")
			e := &fakeEngine{apparmor: tt.apparmor, loaded: map[string]bool{AppArmorProfile: tt.loaded}}
			d := startFakeEngine(t, e)
			d.apparmorOverride = tt.override

			got, err := d.appArmorProfile(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("profile = %q, want %q", got, tt.want)
			}
			e.mu.Lock()
			defer e.mu.Unlock()
			if tt.override != "" && e.calls != 0 {
				t.Errorf("override still queried the engine (%d calls)", e.calls)
			}
			probed := len(e.removed) > 0
			if probed != tt.wantProbe {
				t.Errorf("probed = %v, want %v", probed, tt.wantProbe)
			}
			if len(e.created) != 0 {
				t.Errorf("probe container left behind: %v", e.created)
			}
		})
	}
}

func TestAppArmorProfileIsCachedUntilForgotten(t *testing.T) {
	hostFiles(t, "", "0")
	e := &fakeEngine{apparmor: true, loaded: map[string]bool{}}
	d := startFakeEngine(t, e)
	ctx := context.Background()

	if got, _ := d.appArmorProfile(ctx); got != "unconfined" {
		t.Fatalf("profile = %q before the profile is loaded", got)
	}
	e.mu.Lock()
	e.loaded[AppArmorProfile] = true
	e.mu.Unlock()
	if got, _ := d.appArmorProfile(ctx); got != "unconfined" {
		t.Errorf("profile = %q; want the cached choice", got)
	}
	d.forgetAppArmorProfile()
	if got, _ := d.appArmorProfile(ctx); got != AppArmorProfile {
		t.Errorf("profile = %q after forget; want %q", got, AppArmorProfile)
	}
}

func TestContainerSpecAppArmor(t *testing.T) {
	d := &daemon{image: BuildKitImage}
	for _, profile := range []string{"unconfined", AppArmorProfile} {
		opts := d.containerSpec("prj_A", "172.30.0.1", profile, "h")["HostConfig"].(map[string]any)["SecurityOpt"].([]string)
		if len(opts) != 2 || opts[0] != "seccomp=unconfined" || opts[1] != "apparmor="+profile {
			t.Errorf("SecurityOpt for %s = %q", profile, opts)
		}
	}
}

func TestUserNamespaceDenial(t *testing.T) {
	// Verbatim from sys_buildkitd on an ubuntu-24.04 GitHub runner.
	logs := "[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: permission denied\n" +
		"This error might have happened because /proc/sys/kernel/apparmor_restrict_unprivileged_userns is set to 1"
	if !userNamespaceDenied(logs) {
		t.Error("runner failure not recognised")
	}
	if userNamespaceDenied("buildkitd: running server on /run/user/1000/buildkit/buildkitd.sock") {
		t.Error("healthy output recognised as a denial")
	}
	if h := userNamespaceHint("unconfined"); !strings.Contains(h, "apparmor_parser -r "+AppArmorProfileFile) ||
		!strings.Contains(h, "install.sh") {
		t.Errorf("hint without the fix: %s", h)
	}
	if h := userNamespaceHint(AppArmorProfile); !strings.Contains(h, "aa-status") {
		t.Errorf("hint under the profile: %s", h)
	}
}

func TestAppArmorProfileValidation(t *testing.T) {
	for _, name := range []string{"unconfined", AppArmorProfile, "site.buildkit_v2"} {
		if !validAppArmorProfile(name) {
			t.Errorf("%q rejected", name)
		}
	}
	for _, name := range []string{"", "-x", "a,b", "a b", "a=b", "../x", strings.Repeat("a", 200)} {
		if validAppArmorProfile(name) {
			t.Errorf("%q accepted", name)
		}
	}
	if _, err := New(Options{DataDir: t.TempDir(), AppArmorProfile: "x,seccomp=unconfined"}); err == nil {
		t.Error("New accepted an AppArmor profile that smuggles another security option")
	}
}

func TestInstallerEmbedsAppArmorProfile(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("..", "..", "..", "install", "roundhouse-buildkit.apparmor"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(want), "profile "+AppArmorProfile+" flags=(unconfined)") {
		t.Errorf("install/roundhouse-buildkit.apparmor does not define %s", AppArmorProfile)
	}
	script, err := os.ReadFile(filepath.Join("..", "..", "..", "install", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	s := strings.ReplaceAll(string(script), "\r\n", "\n")
	if !strings.Contains(s, "\n"+strings.ReplaceAll(string(want), "\r\n", "\n")+"APPARMOR\n") {
		t.Error("install/install.sh does not embed install/roundhouse-buildkit.apparmor verbatim")
	}
	for _, path := range []string{"BUILDKIT_APPARMOR_FILE=" + AppArmorProfileFile, "BUILDKIT_APPARMOR_PROFILE=" + AppArmorProfile} {
		if !strings.Contains(s, "\n"+path+"\n") {
			t.Errorf("install/install.sh lacks %s", path)
		}
	}
}
