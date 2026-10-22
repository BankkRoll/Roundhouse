package conn

import (
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

func TestBackoffGrowsAndCaps(t *testing.T) {
	s := time.Second
	for _, tc := range []struct {
		name string
		rand float64
		want []time.Duration
	}{
		{"upper bound", 1, []time.Duration{1 * s, 2 * s, 4 * s, 8 * s, 16 * s, 32 * s, 60 * s, 60 * s}},
		{"lower bound", 0, []time.Duration{s / 2, 1 * s, 2 * s, 4 * s, 8 * s, 16 * s, 30 * s, 30 * s}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewBackoff(time.Second, time.Minute)
			b.rand = func() float64 { return tc.rand }
			for i, want := range tc.want {
				if got := b.Next(); got != want {
					t.Fatalf("attempt %d: got %v, want %v", i, got, want)
				}
			}
		})
	}
}

func TestBackoffStaysInRangeForever(t *testing.T) {
	b := NewBackoff(time.Second, time.Minute)
	for i := range 200 {
		d := b.Next()
		if d <= 0 || d > time.Minute {
			t.Fatalf("attempt %d: delay %v out of range", i, d)
		}
		if i > 10 && d < 30*time.Second {
			t.Fatalf("attempt %d: delay %v below half the cap", i, d)
		}
	}
}

func TestBackoffReset(t *testing.T) {
	b := NewBackoff(time.Second, time.Minute)
	b.rand = func() float64 { return 0 }
	for range 5 {
		b.Next()
	}
	b.Reset()
	if got := b.Next(); got != 500*time.Millisecond {
		t.Fatalf("got %v after reset", got)
	}
}

func TestRetryDelayUnauthorizedUsesCap(t *testing.T) {
	b := NewBackoff(time.Second, time.Minute)
	if got := retryDelay(b, fmt.Errorf("dial: %w", errUnauthorized)); got != time.Minute {
		t.Fatalf("got %v, want cap", got)
	}
	if got := retryDelay(b, errors.New("connection refused")); got > time.Second {
		t.Fatalf("got %v, want first exponential step", got)
	}
}

func TestBackoffDoesNotWrap(t *testing.T) {
	b := NewBackoff(time.Hour, time.Duration(math.MaxInt64))
	prev := time.Duration(0)
	for i := range 100 {
		d := b.Next()
		if d <= 0 {
			t.Fatalf("attempt %d: delay %v wrapped", i, d)
		}
		if i > 0 && d < prev/2 {
			t.Fatalf("attempt %d: delay %v shrank from %v", i, d, prev)
		}
		prev = d
	}
}

func TestNewBackoffSanitisesBounds(t *testing.T) {
	b := NewBackoff(0, -time.Second)
	if b.Min <= 0 || b.Max < b.Min {
		t.Fatalf("got min %v max %v", b.Min, b.Max)
	}
	if d := b.Next(); d <= 0 {
		t.Fatalf("delay %v", d)
	}
}
