package runtime

import (
	"slices"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// With DNS-resolved upstreams the ingress keeps sending requests to a
// replaced container for up to one refresh interval, so it must outlive
// that even with drain_s 0.
func TestMinDrainHoldsReplacedContainer(t *testing.T) {
	const minDrain = 400 * time.Millisecond
	h := newHarness(t, func(o *Options) { o.MinDrain = minDrain })
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	w.DrainS = 0
	w = rehash(w)
	h.rt.Apply(desired(1, w))
	old := h.running("wl_a")

	w2 := w
	// The environment is fixed per workload ID (ADR 0014), so a changed
	// command stands in for any hashed change.
	w2.Command = []string{"nginx", "-g", "daemon off;"}
	w2 = rehash(w2)
	h.rt.Apply(desired(2, w2))
	switchedAway := func(c ingress.Config) bool {
		r := c.Routes
		return len(r) == 1 && len(r[0].Upstreams) == 1 && r[0].Upstreams[0] != old.ip+":80"
	}
	eventually(t, "routes to switch to the replacement", func() bool { return switchedAway(h.ing.last()) })
	eventually(t, "the replaced container to be removed", func() bool { _, ok := h.d.removedAt(old.name); return ok })
	// Both instants come from the fakes as the runtime acts, not from when
	// this goroutine next polls, which a loaded machine can delay by far
	// more than the margin.
	switched, _ := h.ing.appliedAt(switchedAway)
	removed, _ := h.d.removedAt(old.name)
	if held := removed.Sub(switched); held < minDrain-50*time.Millisecond {
		t.Fatalf("replaced container removed %v after the switch, want at least %v", held, minDrain)
	}
	if !slices.Contains(h.d.opLog(), "stop "+old.name) {
		t.Fatal("old container was never stopped")
	}
	if h.state("wl_a") != protocol.StateHealthy {
		t.Fatalf("state %s", h.state("wl_a"))
	}
}
