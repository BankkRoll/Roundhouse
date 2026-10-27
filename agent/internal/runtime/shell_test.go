package runtime

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestShellContainer(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := h.rt.ShellContainer("wl_a"); err == nil {
		t.Fatal("shell target before any desired state")
	}
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	c := h.running("wl_a")
	eventually(t, "the runtime to see the container running", func() bool {
		id, err := h.rt.ShellContainer("wl_a")
		return err == nil && id == c.id
	})
	for _, id := range []string{"wl_missing", RegistryWorkloadID} {
		if _, err := h.rt.ShellContainer(id); err == nil {
			t.Fatalf("%s is a shell target", id)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	release, err := h.rt.Hold(ctx, "wl_a", "", "restoring backup bak_1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.rt.ShellContainer("wl_a"); err == nil || !strings.Contains(err.Error(), "restoring backup") {
		t.Fatalf("held workload: %v", err)
	}
	release()
	eventually(t, "the released workload to be a target again", func() bool {
		_, err := h.rt.ShellContainer("wl_a")
		return err == nil
	})
}
