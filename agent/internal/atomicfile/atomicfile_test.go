package atomicfile

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestWriteCreatesAndReplaces(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", "file")
	for _, content := range []string{"first", "second, longer than the first"} {
		if err := Write(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != content {
			t.Fatalf("got %q, %v; want %q", got, err, content)
		}
	}

	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("perm = %o, want 600", perm)
		}
	}
}

func TestWriteFailureKeepsOldContents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := Write(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A directory in the way makes the final rename fail.
	blocked := filepath.Join(dir, "blocked")
	if err := os.MkdirAll(filepath.Join(blocked, "child"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := Write(blocked, []byte("new"), 0o600); err == nil {
		t.Fatal("expected rename over a non-empty directory to fail")
	}
	if got, _ := os.ReadFile(path); string(got) != "original" {
		t.Fatalf("unrelated file changed: %q", got)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "file" && e.Name() != "blocked" {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

func TestWriteSurvivesConcurrentReaders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := Write(path, []byte("0"), 0o600); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				_, _ = os.ReadFile(path)
			}
		}
	}()
	defer func() {
		close(stop)
		<-done
	}()
	for i := range 100 {
		if err := Write(path, []byte(strconv.Itoa(i)), 0o600); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
}
