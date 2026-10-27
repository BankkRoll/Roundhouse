package runtime

import (
	"testing"
	"time"
)

// TestApplyWhileReconciling replaces the desired state and its admission
// verdicts while the reconciler reads them; -race catches a verdict map
// read outside r.mu.
func TestApplyWhileReconciling(t *testing.T) {
	h := newHarness(t, nil)
	w := spec("wl_a", "svc_web")
	// An image reference admit refuses, so every state carries a verdict.
	w.Image = "UPPER/case:bad"
	deadline := time.Now().Add(500 * time.Millisecond)
	for gen := int64(1); time.Now().Before(deadline); gen++ {
		h.rt.Apply(desired(gen, w))
		h.rt.Poke()
	}
}
