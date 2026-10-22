// Package clock estimates how far the local clock is from the control
// plane's, using the Date header of control-plane HTTP responses.
//
// Control frames carry absolute expiry times, so a node whose clock runs fast
// would otherwise reject every frame as expired.
package clock

import (
	"net/http"
	"time"
)

// WarnThreshold is the offset beyond which callers should warn the operator
// that the host clock needs fixing (for example, NTP is not running).
const WarnThreshold = 30 * time.Second

// OffsetFromResponse returns how far the control plane's clock is ahead of the
// local one, judged from resp's Date header. sent and received bracket the
// request on the local clock. It reports false if resp has no usable Date.
//
// The result is accurate to about a second: Date has one-second resolution,
// so the server time is assumed to sit mid-way through that second, and the
// local time mid-way through the round trip.
func OffsetFromResponse(resp *http.Response, sent, received time.Time) (time.Duration, bool) {
	if resp == nil {
		return 0, false
	}
	date, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return 0, false
	}
	server := date.Add(500 * time.Millisecond)
	local := sent.Add(received.Sub(sent) / 2)
	return server.Sub(local), true
}
