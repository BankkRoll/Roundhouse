package builder

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

func TestNewDefaultsAndValidation(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Error("missing DataDir accepted")
	}
	if _, err := New(Options{DataDir: t.TempDir(), RegistryAddr: "nohostport"}); err == nil {
		t.Error("bad RegistryAddr accepted")
	}
	if _, err := New(Options{DataDir: t.TempDir(), DockerHost: "tcp://1.2.3.4:2375"}); err == nil {
		t.Error("tcp DockerHost accepted")
	}
	if _, err := New(Options{DataDir: t.TempDir(), RegistryProxyPort: 70000}); err == nil {
		t.Error("bad proxy port accepted")
	}
	b, err := New(Options{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	o := b.(*builder).opts
	if o.RegistryAddr != protocol.RegistryListen || o.Timeout != DefaultTimeout || o.BuildKitImage != BuildKitImage ||
		o.RailpackFrontendImage != RailpackFrontendImage || o.RegistryProxyPort != DefaultRegistryProxyPort ||
		o.CacheMaxBytes != DefaultCacheMaxBytes || o.GitPath != "git" || o.RailpackPath != "railpack" {
		t.Errorf("defaults not applied: %+v", o)
	}
}

// offlineBuilder has no reachable Docker engine, so anything past the
// source fetch fails; it exercises everything before it.
func offlineBuilder(t *testing.T, mutate func(*Options)) *builder {
	t.Helper()
	opts := Options{
		DataDir:           t.TempDir(),
		DockerHost:        "unix://" + filepath.Join(t.TempDir(), "no-docker.sock"),
		AllowLoopbackHTTP: true,
		MinFreeBytes:      1,
	}
	if mutate != nil {
		mutate(&opts)
	}
	b, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	return b.(*builder)
}

func TestRunRejectsInvalidJobAndCleansUp(t *testing.T) {
	b := offlineBuilder(t, nil)
	job := validJob()
	job.ContextDir = "../escape"
	sink := newFrameSink()
	res := b.Run(context.Background(), job, sink.emit)
	if res.OK || !strings.Contains(res.Error, "must be a relative path inside the repository") {
		t.Fatalf("result %+v", res)
	}
	if err := res.Validate(); err != nil {
		t.Fatal(err)
	}
	frames := sink.all()
	if len(frames) == 0 || !strings.Contains(frames[len(frames)-1].Lines[len(frames[len(frames)-1].Lines)-1].Text, "Error:") {
		t.Errorf("failure not logged: %+v", frames)
	}
	entries, _ := os.ReadDir(filepath.Join(b.opts.DataDir, "builds"))
	if len(entries) != 0 {
		t.Errorf("build directory left behind: %v", entries)
	}
}

func TestRunMissingDockerfileBeatsDaemonErrors(t *testing.T) {
	s := newUnitGitServer(t, false)
	first, _ := s.commit(t, "app")
	b := offlineBuilder(t, nil)
	// Left by an agent that died mid-build.
	writeFile(t, filepath.Join(b.opts.DataDir, "builds", "bld_old-123", "src", "f"), "x")
	job := validJob()
	job.Source.URL, job.Source.CommitSHA = s.url+"/app.git", first
	res := b.Run(context.Background(), job, nil)
	if res.Error != `Dockerfile not found at "Dockerfile" in the repository` {
		t.Fatalf("error = %q", res.Error)
	}
	entries, _ := os.ReadDir(filepath.Join(b.opts.DataDir, "builds"))
	if len(entries) != 0 {
		t.Errorf("build directory left behind: %v", entries)
	}
}

func TestRunLowDisk(t *testing.T) {
	b := offlineBuilder(t, func(o *Options) { o.MinFreeBytes = 1 << 62 })
	res := b.Run(context.Background(), validJob(), nil)
	if !strings.Contains(res.Error, "low on disk space") {
		t.Fatalf("error = %q", res.Error)
	}
}

func TestRunTimeoutKillsAndBusy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell script as git")
	}
	fake := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 120\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	b := offlineBuilder(t, func(o *Options) {
		o.GitPath = fake
		o.Timeout = 2 * time.Second
	})

	var wg sync.WaitGroup
	var first protocol.BuildResult
	wg.Add(1)
	start := time.Now()
	go func() {
		defer wg.Done()
		first = b.Run(context.Background(), validJob(), nil)
	}()

	// A second build while the first holds the builder is refused at once.
	// The first build has the lock once its work directory exists.
	for {
		if entries, _ := os.ReadDir(filepath.Join(b.opts.DataDir, "builds")); len(entries) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	job := validJob()
	job.BuildID = "bld_second"
	second := b.Run(context.Background(), job, nil)
	if second.Error != "Another build is already running on this builder node." || second.BuildID != "bld_second" {
		t.Errorf("concurrent build: %+v", second)
	}

	wg.Wait()
	elapsed := time.Since(start)
	if first.OK || first.Error != "Build timed out after 2s and was stopped." {
		t.Fatalf("result %+v", first)
	}
	if elapsed > 10*time.Second {
		t.Errorf("Run returned after %s; git was not killed", elapsed)
	}
}

func TestRunCancelled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs a shell script as git")
	}
	fake := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexec sleep 120\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	b := offlineBuilder(t, func(o *Options) { o.GitPath = fake })
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	res := b.Run(ctx, validJob(), nil)
	if res.Error != "Build was cancelled." {
		t.Fatalf("result %+v", res)
	}
}
