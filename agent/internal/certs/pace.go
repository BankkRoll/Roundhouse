package certs

import "time"

// Frames of each type the agent sends per second. The control plane accepts
// twice as many (FRAME_RATE_LIMITS in apps/api/src/durable/node-connection.ts),
// drops frames over its limit and closes a connection that keeps exceeding
// it; half leaves room for its one-second window not lining up with ours.
const (
	requestsPerSecond = 1
	acksPerSecond     = 4
	statusesPerSecond = 16
)

// requestChunk is the most IDs in one cert_request. The control plane
// answers with one cert_sync per [protocol.MaxCertUpsertsPerFrame]
// certificates, so this keeps a reply well inside the store's sync queue.
const requestChunk = 128

// frameBudget paces one frame type to per frames a second, by wall-clock
// time. A zero budget is unlimited.
type frameBudget struct {
	per   int
	start time.Time
	used  int
}

// take reserves a frame at now. When this second's frames are spent it
// returns false and how long until the next second starts.
func (b *frameBudget) take(now time.Time) (bool, time.Duration) {
	if b.per <= 0 {
		return true, 0
	}
	if now.Before(b.start) || now.Sub(b.start) >= time.Second {
		b.start, b.used = now, 0
	}
	if b.used >= b.per {
		return false, b.start.Add(time.Second).Sub(now)
	}
	b.used++
	return true, 0
}
