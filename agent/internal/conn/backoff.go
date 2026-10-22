package conn

import (
	"math/rand/v2"
	"time"
)

// Backoff computes reconnect delays with capped exponential growth and jitter.
// The zero value is not usable; construct with [NewBackoff].
type Backoff struct {
	// Min is the base delay before the first retry.
	Min time.Duration
	// Max caps every delay, jitter included.
	Max time.Duration

	attempt int
	rand    func() float64
}

// NewBackoff returns a backoff that grows from minDelay to maxDelay. A
// non-positive minDelay is raised to 1ms and maxDelay to at least minDelay.
func NewBackoff(minDelay, maxDelay time.Duration) *Backoff {
	minDelay = max(minDelay, time.Millisecond)
	return &Backoff{Min: minDelay, Max: max(maxDelay, minDelay), rand: rand.Float64}
}

// Next returns the delay before the next attempt and advances the sequence.
//
// The delay is drawn uniformly from [d/2, d] where d = min(Min·2ⁿ, Max).
// Keeping half the exponential delay fixed bounds how fast a fleet hammers a
// recovering control plane, while the random half spreads reconnects out.
func (b *Backoff) Next() time.Duration {
	d := b.Min
	// NOTE: doubling stops at the cap and the attempt counter stops with
	// it, so neither the delay nor the counter can overflow.
	for i := 0; i < b.attempt && d < b.Max; i++ {
		if d > b.Max/2 {
			d = b.Max
			break
		}
		d *= 2
	}
	d = min(d, b.Max)
	if d < b.Max {
		b.attempt++
	}
	half := d / 2
	return half + time.Duration(b.rand()*float64(d-half))
}

// Reset restarts the sequence after a healthy connection.
func (b *Backoff) Reset() {
	b.attempt = 0
}
