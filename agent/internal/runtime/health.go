package runtime

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// health is the agent's view of a running container's probe.
type health int

const (
	// healthUnknown: no probe has passed yet.
	healthUnknown health = iota
	healthHealthy
	healthUnhealthy
)

// firstProbeDelay caps the wait before the first probe, so a replica that
// is ready quickly takes over traffic quickly even with a long interval.
const firstProbeDelay = time.Second

// healthTracker is the probe state machine, following Docker's
// HEALTHCHECK semantics:
//   - a pass makes the container healthy at once, even in the start period;
//   - failures in the start period are ignored until the first pass;
//   - otherwise Retries consecutive failures (at least one) make it
//     unhealthy, and a single pass makes it healthy again.
type healthTracker struct {
	hc       protocol.Healthcheck
	started  time.Time
	state    health
	failures int
	// lastErr explains the latest failure.
	lastErr string
}

func newHealthTracker(hc protocol.Healthcheck, started time.Time) *healthTracker {
	return &healthTracker{hc: hc, started: started}
}

// observe records one probe result at time at and reports whether the state
// changed.
func (h *healthTracker) observe(err error, at time.Time) bool {
	if err == nil {
		h.failures = 0
		h.lastErr = ""
		if h.state != healthHealthy {
			h.state = healthHealthy
			return true
		}
		return false
	}
	h.lastErr = err.Error()
	inStartPeriod := at.Before(h.started.Add(time.Duration(h.hc.StartPeriodS) * time.Second))
	if inStartPeriod && h.state == healthUnknown {
		return false
	}
	h.failures++
	if h.failures >= max(h.hc.Retries, 1) && h.state != healthUnhealthy {
		h.state = healthUnhealthy
		return true
	}
	return false
}

// firstDelay is the wait from container start to the first probe.
func (h *healthTracker) firstDelay() time.Duration {
	return min(firstProbeDelay, h.interval())
}

func (h *healthTracker) interval() time.Duration {
	return time.Duration(h.hc.IntervalS) * time.Second
}

func (h *healthTracker) timeout() time.Duration {
	return time.Duration(h.hc.TimeoutS) * time.Second
}

// Prober runs one health probe against a container address and returns nil
// if it passed. The runtime's default is [DefaultProber].
type Prober func(ctx context.Context, hc protocol.Healthcheck, ip string) error

// probeClient never reuses connections, so every probe exercises the
// replica's accept path, and never follows redirects, so a 3xx counts as
// the replica's own answer.
var probeClient = &http.Client{
	Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// DefaultProber runs an HTTP GET (2xx and 3xx pass) or a TCP connect against
// ip:hc.Port. The caller bounds it with hc.TimeoutS through ctx.
func DefaultProber(ctx context.Context, hc protocol.Healthcheck, ip string) error {
	if ip == "" {
		return fmt.Errorf("container has no IP address on its network")
	}
	addr := net.JoinHostPort(ip, strconv.Itoa(hc.Port))
	switch hc.Type {
	case protocol.HealthcheckHTTP:
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+hc.Path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "roundhouse-agent/healthcheck")
		resp, err := probeClient.Do(req)
		if err != nil {
			return fmt.Errorf("GET %s: %w", hc.Path, err)
		}
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 400 {
			return fmt.Errorf("GET %s: HTTP %d", hc.Path, resp.StatusCode)
		}
		return nil
	case protocol.HealthcheckTCP:
		var d net.Dialer
		c, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return fmt.Errorf("connect %s: %w", addr, err)
		}
		return c.Close()
	default:
		return nil
	}
}

// needsProbe reports whether a spec's health is decided by a probe rather
// than by the container merely running.
func needsProbe(s *wantSpec) bool {
	return s.Healthcheck != nil && s.Healthcheck.Type != protocol.HealthcheckNone
}
