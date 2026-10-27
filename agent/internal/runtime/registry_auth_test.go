package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPruneRegistryAuth(t *testing.T) {
	dir := t.TempDir()
	rt := New(Options{Docker: newFakeDocker(), DataDir: dir})
	auth := filepath.Join(dir, registryAuthDir)
	if err := os.MkdirAll(auth, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(auth, "htpasswd"), []byte("node:$2y$hash\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	rt.pruneRegistryAuth([]*wantSpec{{WorkloadSpec: spec(RegistryMeshWorkloadID, "")}})
	if _, err := os.Stat(auth); err != nil {
		t.Fatalf("removed while the listener is wanted: %v", err)
	}
	rt.instances["c1"] = &instance{id: "c1", running: true, meta: meta{workloadID: RegistryMeshWorkloadID}}
	rt.pruneRegistryAuth(nil)
	if _, err := os.Stat(auth); err != nil {
		t.Fatalf("removed while the listener still runs: %v", err)
	}
	delete(rt.instances, "c1")
	rt.pruneRegistryAuth(nil)
	if _, err := os.Stat(auth); !os.IsNotExist(err) {
		t.Fatalf("htpasswd left behind: %v", err)
	}
}
