package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingIsZero(t *testing.T) {
	st, err := NewStore(filepath.Join(t.TempDir(), "state.json")).Load()
	if err != nil || st != (State{}) {
		t.Fatalf("got %+v, %v", st, err)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "sub", "state.json"))
	for _, gen := range []int64{7, 3} {
		if err := s.Save(State{ObservedGeneration: gen}); err != nil {
			t.Fatal(err)
		}
		st, err := s.Load()
		if err != nil || st.ObservedGeneration != gen {
			t.Fatalf("got %+v, %v; want generation %d", st, err, gen)
		}
	}
}

func TestLoadCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(path).Load(); err == nil {
		t.Fatal("expected corrupt state to fail loudly rather than reset to zero")
	}
}
