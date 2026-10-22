package ingress

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Defaults applied when the corresponding [Options] field is zero.
const (
	DefaultAdminURL       = "http://localhost:2019"
	DefaultAdminListen    = "localhost:2019"
	DefaultAskURL         = "http://127.0.0.1:2020/ask"
	DefaultVerifyInterval = 30 * time.Second
	DefaultMinBackoff     = time.Second
	DefaultMaxBackoff     = time.Minute
)

const (
	requestTimeout = 10 * time.Second
	maxAdminBody   = 4 << 20
)

// Options configures a [Manager].
type Options struct {
	// AdminURL is Caddy's admin API base URL.
	AdminURL string
	// Build holds the install-wide config settings; empty AdminListen and
	// AskURL take their defaults.
	Build BuildOptions
	// HTTPClient talks to the admin API; nil uses a client with a 10 s
	// timeout.
	HTTPClient *http.Client
	// Logger receives Caddy availability changes; nil discards them.
	Logger *slog.Logger
	// VerifyInterval is how often the loaded config is compared with the
	// wanted one, catching a Caddy restart that dropped it.
	VerifyInterval time.Duration
	// MinBackoff and MaxBackoff bound retries while Caddy is unreachable.
	MinBackoff, MaxBackoff time.Duration
}

// Manager keeps Caddy's config equal to the latest [Config] it was given.
// Create it with [New]; [Manager.Apply] may be called before and while
// [Manager.Run] runs.
type Manager struct {
	opts Options
	hc   *http.Client
	log  *slog.Logger

	// loadMu serialises loads so an older config never lands after a newer
	// one.
	loadMu sync.Mutex

	mu       sync.Mutex
	want     []byte
	wantHash string
	// applied is the hash of the config Caddy last accepted.
	applied string
	// up is nil until the first attempt, then whether Caddy accepted the
	// latest one.
	up *bool

	allowed atomic.Pointer[map[string]struct{}]
	wake    chan struct{}
}

// New returns a manager. Nothing is sent to Caddy until [Manager.Apply].
func New(opts Options) *Manager {
	opts.AdminURL = strings.TrimSuffix(cmp.Or(opts.AdminURL, DefaultAdminURL), "/")
	opts.Build.AdminListen = cmp.Or(opts.Build.AdminListen, DefaultAdminListen)
	opts.Build.AskURL = cmp.Or(opts.Build.AskURL, DefaultAskURL)
	opts.VerifyInterval = cmp.Or(opts.VerifyInterval, DefaultVerifyInterval)
	opts.MinBackoff = cmp.Or(opts.MinBackoff, DefaultMinBackoff)
	opts.MaxBackoff = max(cmp.Or(opts.MaxBackoff, DefaultMaxBackoff), opts.MinBackoff)
	m := &Manager{
		opts: opts,
		hc:   opts.HTTPClient,
		log:  opts.Logger,
		wake: make(chan struct{}, 1),
	}
	if m.hc == nil {
		m.hc = &http.Client{Timeout: requestTimeout}
	}
	if m.log == nil {
		m.log = slog.New(slog.DiscardHandler)
	}
	empty := map[string]struct{}{}
	m.allowed.Store(&empty)
	return m
}

// Apply makes c the wanted config. The ask allowlist changes immediately;
// Caddy is loaded synchronously only if the generated config differs from
// the one it last accepted. On failure Apply returns the error and
// [Manager.Run] keeps retrying in the background.
func (m *Manager) Apply(ctx context.Context, c Config) error {
	hosts := make(map[string]struct{}, len(c.AllowedHosts))
	for _, h := range c.AllowedHosts {
		hosts[strings.ToLower(h)] = struct{}{}
	}
	m.allowed.Store(&hosts)

	cfg := BuildConfig(c, m.opts.Build)
	h := Hash(cfg)
	m.mu.Lock()
	m.want, m.wantHash = cfg, h
	same := h == m.applied
	m.mu.Unlock()
	if same {
		return nil
	}
	err := m.load(ctx)
	if err != nil {
		m.poke()
	}
	return err
}

// Healthy reports whether Caddy accepted the latest config. It is false
// before the first attempt.
func (m *Manager) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.up != nil && *m.up && m.applied == m.wantHash
}

// AppliedHash returns the hash of the config Caddy last accepted, or "".
func (m *Manager) AppliedHash() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.applied
}

// Run retries failed loads with capped exponential backoff and periodically
// verifies that Caddy still holds the wanted config, until ctx ends.
func (m *Manager) Run(ctx context.Context) error {
	verify := time.NewTicker(m.opts.VerifyInterval)
	defer verify.Stop()
	retry := time.NewTimer(0)
	if !retry.Stop() {
		<-retry.C
	}
	delay := m.opts.MinBackoff
	attempt := func() {
		if m.pending() {
			if err := m.load(ctx); err != nil {
				retry.Reset(delay)
				delay = min(delay*2, m.opts.MaxBackoff)
				return
			}
		}
		delay = m.opts.MinBackoff
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-m.wake:
			retry.Stop()
			attempt()
		case <-retry.C:
			attempt()
		case <-verify.C:
			if !m.pending() && m.drifted(ctx) {
				m.mu.Lock()
				m.applied = ""
				m.mu.Unlock()
				m.log.Warn("caddy config differs from the agent's; reloading (caddy restarted?)")
				attempt()
			}
		}
	}
}

func (m *Manager) poke() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// pending reports whether a config is wanted that Caddy has not accepted.
func (m *Manager) pending() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.want != nil && m.applied != m.wantHash
}

// load posts the latest wanted config.
func (m *Manager) load(ctx context.Context) error {
	m.loadMu.Lock()
	defer m.loadMu.Unlock()
	m.mu.Lock()
	cfg, h := m.want, m.wantHash
	done := m.applied == h
	m.mu.Unlock()
	if done || cfg == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	err := m.post(ctx, cfg)

	m.mu.Lock()
	wasUp := m.up
	up := err == nil
	m.up = &up
	if up {
		m.applied = h
	}
	m.mu.Unlock()

	switch {
	case err != nil && (wasUp == nil || *wasUp):
		m.log.Warn("caddy admin API unavailable; routes are not being updated, retrying", "admin", m.opts.AdminURL, "err", err)
	case err == nil && wasUp != nil && !*wasUp:
		m.log.Info("caddy admin API is back; routes updated", "config_hash", h)
	case err == nil:
		m.log.Debug("caddy config loaded", "config_hash", h)
	}
	return err
}

func (m *Manager) post(ctx context.Context, cfg []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.opts.AdminURL+"/load", bytes.NewReader(cfg))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("caddy /load: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// drifted reports whether Caddy's running config differs from the one it
// last accepted from the agent. Errors count as no drift: an unreachable
// Caddy is retried by the next load, not by this check.
func (m *Manager) drifted(ctx context.Context) bool {
	m.mu.Lock()
	want := m.want
	m.mu.Unlock()
	if want == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.opts.AdminURL+"/config/", nil)
	if err != nil {
		return false
	}
	resp, err := m.hc.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAdminBody))
	if err != nil || resp.StatusCode != http.StatusOK {
		return false
	}
	equal, err := jsonEqual(data, want)
	return err == nil && !equal
}

func jsonEqual(a, b []byte) (bool, error) {
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, &y); err != nil {
		return false, errors.New("invalid wanted config")
	}
	return reflect.DeepEqual(x, y), nil
}
