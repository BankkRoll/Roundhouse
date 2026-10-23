package runtime

import (
	"slices"
	"testing"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
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
	w2.Env = map[string]string{"GREETING": "bonjour"}
	w2 = rehash(w2)
	h.rt.Apply(desired(2, w2))
	var switched time.Time
	eventually(t, "routes to switch to the replacement", func() bool {
		r := h.ing.last().Routes
		if len(r) == 1 && len(r[0].Upstreams) == 1 && r[0].Upstreams[0] != old.ip+":80" {
			switched = time.Now()
			return true
		}
		return false
	})
	eventually(t, "the replaced container to be removed", func() bool { return len(h.d.byWorkload("wl_a")) == 1 })
	if held := time.Since(switched); held < minDrain-50*time.Millisecond {
		t.Fatalf("replaced container removed %v after the switch, want at least %v", held, minDrain)
	}
	if !slices.Contains(h.d.opLog(), "stop "+old.name) {
		t.Fatal("old container was never stopped")
	}
	if h.state("wl_a") != protocol.StateHealthy {
		t.Fatalf("state %s", h.state("wl_a"))
	}
}
