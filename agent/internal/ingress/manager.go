package ingress

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"net/netip"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Defaults applied when the corresponding [Options] field is zero.
const (
	DefaultAdminURL       = "http://localhost:2019"
	DefaultAdminListen    = "localhost:2019"
	DefaultAskURL         = "http://127.0.0.1:2020/ask"
	DefaultVerifyInterval = 30 * time.Second
	DefaultMinBackoff     = time.Second
	DefaultMaxBackoff     = time.Minute
	// DefaultRenewalInterval is the least time between two loads that
	// carry certificate renewals (ADR 0009, "Reload cost").
	DefaultRenewalInterval = 10 * time.Minute
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
	// UpstreamsPath persists the DNS answers so a restarted agent serves
	// them at once, before its first desired state; "" keeps them in
	// memory only. They name container IPs and nothing secret.
	UpstreamsPath string
	// OnLoaded is called whenever Caddy is known to run a config the
	// manager built, with what that config serves, once per change. It is
	// called with loads serialised and must not block or call back into the
	// manager.
	OnLoaded func(Loaded)
	// RenewalInterval is the least time between loads made only to pick up
	// renewed certificates. Default [DefaultRenewalInterval].
	RenewalInterval time.Duration
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
}

// Loaded describes a config Caddy accepted.
type Loaded struct {
	TLSMode protocol.TLSMode
	// Hosts are the exact, unmanaged hostnames Caddy may issue certificates
	// for on demand, sorted: the ask endpoint's allowlist.
	Hosts []string
	// Certificates maps the ID of every loaded certificate file to the
	// SHA-256 of the chain the config names.
	Certificates map[string]string
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
	// probed is set once Caddy's running config has been compared with the
	// wanted one, which spares a reload after an agent restart.
	probed bool
	// loads counts successful POST /load calls.
	loads int
	// persisted is the encoding of the DNS answers last written to disk.
	persisted []byte

	// cfg is the latest config given to Apply; nil until the first.
	cfg *Config
	// certs are the certificates to load, by ID.
	certs map[string]Certificate
	// wantCerts are the certificates in want, by ID.
	wantCerts map[string]Certificate
	// wantInfo describes want, for OnLoaded.
	wantInfo Loaded
	// lastRenewal is when a wanted config last picked up a renewal.
	lastRenewal time.Time
	// renewTimer fires when deferred renewals are due.
	renewTimer *time.Timer
	// notified is what OnLoaded was last called with.
	notified *Loaded

	dns     *dnsServer
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
	opts.Build.Resolver = cmp.Or(opts.Build.Resolver, DefaultDNSListen)
	opts.RenewalInterval = cmp.Or(opts.RenewalInterval, DefaultRenewalInterval)
	if opts.Now == nil {
		opts.Now = time.Now
	}
	m := &Manager{
		opts: opts,
		hc:   opts.HTTPClient,
		log:  opts.Logger,
		wake: make(chan struct{}, 1),
		dns:  newDNSServer(),
	}
	if m.hc == nil {
		m.hc = &http.Client{Timeout: requestTimeout}
	}
	if m.log == nil {
		m.log = slog.New(slog.DiscardHandler)
	}
	empty := map[string]struct{}{}
	m.allowed.Store(&empty)
	m.loadUpstreams()
	return m
}

// Apply makes c the wanted config. The ask allowlist and the upstream DNS
// answers change immediately, so a swap reaches Caddy within one refresh
// interval without touching its config; Caddy is loaded synchronously only
// if the generated config differs from the one it last accepted, which
// takes a change to the routes, their ports, HSTS, the TLS mode, the managed
// hosts or the certificates. On failure Apply returns the error and
// [Manager.Run] keeps retrying in the background. c.Certificates is ignored:
// see [Manager.SetCertificates].
func (m *Manager) Apply(ctx context.Context, c Config) error {
	managed := make(map[string]struct{}, len(c.ManagedHosts))
	for _, h := range c.ManagedHosts {
		managed[strings.ToLower(h)] = struct{}{}
	}
	hosts := make(map[string]struct{}, len(c.AllowedHosts))
	for _, h := range c.AllowedHosts {
		h = strings.ToLower(h)
		// SECURITY: a wildcard would let anyone pick names under it, and a
		// managed host's certificate comes from the control plane only.
		if _, ok := managed[h]; ok || isWildcard(h) || h == "" {
			continue
		}
		hosts[h] = struct{}{}
	}
	m.allowed.Store(&hosts)
	// NOTE: answers go out before a load that adds a route, so the route
	// resolves the moment Caddy has it.
	m.setUpstreams(BuildTable(c))

	c.Certificates = nil
	m.mu.Lock()
	m.cfg = &c
	m.mu.Unlock()
	return m.rebuild(ctx)
}

// SetCertificates replaces the certificate files Caddy loads in managed
// mode. A new or removed ID changes the config at once. A renewal, an ID
// already in the config with another digest, waits until the next load
// that happens anyway or until [Options.RenewalInterval] has passed since
// the last load made for renewals, whichever is first. Nothing loads before
// the first [Manager.Apply].
func (m *Manager) SetCertificates(ctx context.Context, certs []Certificate) error {
	byID := make(map[string]Certificate, len(certs))
	for _, c := range certs {
		byID[c.ID] = c
	}
	m.mu.Lock()
	m.certs = byID
	m.mu.Unlock()
	return m.rebuild(ctx)
}

// rebuild plans the wanted config and loads it if Caddy does not run it.
func (m *Manager) rebuild(ctx context.Context) error {
	same, info, ok := m.plan()
	if !ok {
		return nil
	}
	if same {
		m.notify(info)
		return nil
	}
	err := m.load(ctx)
	if err != nil {
		m.poke()
	}
	return err
}

// replan plans again, for deferred renewals that came due; [Manager.Run]
// loads the result.
func (m *Manager) replan() {
	if same, info, ok := m.plan(); ok && same {
		m.notify(info)
	}
}

// plan builds the wanted config from the latest inputs and reports whether
// Caddy already runs it; ok is false before the first [Manager.Apply].
func (m *Manager) plan() (same bool, info Loaded, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg == nil {
		return false, Loaded{}, false
	}
	c := *m.cfg
	var use map[string]Certificate
	var cfg []byte
	if c.TLSMode == protocol.TLSManaged {
		now := m.opts.Now()
		fresh, deferred, renewals := splitRenewals(m.certs, m.wantCerts)
		use = deferred
		c.Certificates = certList(deferred)
		cfg = BuildConfig(c, m.opts.Build)
		if renewals {
			due := m.lastRenewal.IsZero() || now.Sub(m.lastRenewal) >= m.opts.RenewalInterval
			// A load that happens anyway costs nothing extra to carry them.
			if due || Hash(cfg) != m.applied {
				if due {
					m.lastRenewal = now
				}
				use = fresh
				c.Certificates = certList(fresh)
				cfg = BuildConfig(c, m.opts.Build)
			} else {
				m.armRenewal(m.lastRenewal.Add(m.opts.RenewalInterval).Sub(now))
			}
		}
	} else {
		cfg = BuildConfig(c, m.opts.Build)
	}
	h := Hash(cfg)
	shas := make(map[string]string, len(use))
	for id, cert := range use {
		shas[id] = cert.SHA256
	}
	hosts := make([]string, 0, len(*m.allowed.Load()))
	for h := range *m.allowed.Load() {
		hosts = append(hosts, h)
	}
	slices.Sort(hosts)
	m.want, m.wantHash, m.wantCerts = cfg, h, use
	m.wantInfo = Loaded{TLSMode: c.TLSMode, Hosts: hosts, Certificates: shas}
	return h == m.applied, m.wantInfo, true
}

// armRenewal pokes [Manager.Run] after d. Caller holds m.mu.
func (m *Manager) armRenewal(d time.Duration) {
	if m.renewTimer != nil {
		m.renewTimer.Stop()
	}
	m.renewTimer = time.AfterFunc(max(d, 0), m.poke)
}

// splitRenewals returns want as is (fresh), and with every renewal (an ID
// in base with another digest) replaced by its base entry (deferred), and
// whether there was any renewal.
func splitRenewals(want, base map[string]Certificate) (fresh, deferred map[string]Certificate, renewals bool) {
	deferred = make(map[string]Certificate, len(want))
	for id, c := range want {
		if old, ok := base[id]; ok && old.SHA256 != c.SHA256 {
			deferred[id] = old
			renewals = true
			continue
		}
		deferred[id] = c
	}
	return want, deferred, renewals
}

func certList(m map[string]Certificate) []Certificate {
	out := make([]Certificate, 0, len(m))
	for _, c := range m {
		out = append(out, c)
	}
	return out
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

// Loads returns how many times this manager has loaded a config into Caddy.
func (m *Manager) Loads() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.loads
}

// Upstreams returns the current DNS answers, by name.
func (m *Manager) Upstreams() map[string][]netip.Addr {
	return maps.Clone(m.dns.get())
}

// setUpstreams publishes new DNS answers and persists them when they changed.
func (m *Manager) setUpstreams(t map[string][]netip.Addr) {
	m.dns.set(t)
	if m.opts.UpstreamsPath == "" {
		return
	}
	data, err := json.Marshal(t)
	if err != nil {
		return
	}
	m.mu.Lock()
	same := bytes.Equal(data, m.persisted)
	if !same {
		m.persisted = data
	}
	m.mu.Unlock()
	if same {
		return
	}
	if err := atomicfile.Write(m.opts.UpstreamsPath, data, 0o600); err != nil {
		m.log.Warn("persist upstream DNS answers", "path", m.opts.UpstreamsPath, "err", err)
	}
}

// loadUpstreams serves the answers persisted by an earlier agent process.
// The containers they name kept running through the restart, so they are
// right until the runtime computes fresh ones.
func (m *Manager) loadUpstreams() {
	if m.opts.UpstreamsPath == "" {
		return
	}
	data, err := os.ReadFile(m.opts.UpstreamsPath)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("read upstream DNS answers", "path", m.opts.UpstreamsPath, "err", err)
		}
		return
	}
	t := map[string][]netip.Addr{}
	if err := json.Unmarshal(data, &t); err != nil {
		m.log.Warn("upstream DNS answers file is corrupt; ignoring it", "path", m.opts.UpstreamsPath, "err", err)
		return
	}
	m.dns.set(t)
	m.persisted = data
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
			m.replan()
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
	cfg, h, info := m.want, m.wantHash, m.wantInfo
	done := m.applied == h
	probe := !m.probed
	m.mu.Unlock()
	if done || cfg == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	// After an agent restart Caddy usually still runs the config this agent
	// would load; adopting it avoids a needless reload and the connection
	// resets that come with one.
	if probe {
		if current, ok := m.current(ctx); ok {
			m.mu.Lock()
			m.probed = true
			m.mu.Unlock()
			if equal, err := jsonEqual(current, cfg); err == nil && equal {
				m.mu.Lock()
				up := true
				m.up, m.applied = &up, h
				m.mu.Unlock()
				m.log.Debug("caddy already runs the wanted config", "config_hash", h)
				m.notify(info)
				return nil
			}
		}
	}
	err := m.post(ctx, cfg)

	m.mu.Lock()
	wasUp := m.up
	up := err == nil
	m.up = &up
	if up {
		m.applied = h
		m.loads++
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
	if err == nil {
		m.notify(info)
	}
	return err
}

// notify calls OnLoaded with info unless it was the last thing it was
// called with.
func (m *Manager) notify(info Loaded) {
	if m.opts.OnLoaded == nil {
		return
	}
	m.mu.Lock()
	same := m.notified != nil && m.notified.TLSMode == info.TLSMode &&
		slices.Equal(m.notified.Hosts, info.Hosts) && maps.Equal(m.notified.Certificates, info.Certificates)
	if !same {
		m.notified = &info
	}
	m.mu.Unlock()
	if !same {
		m.opts.OnLoaded(info)
	}
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
	data, ok := m.current(ctx)
	if !ok {
		return false
	}
	equal, err := jsonEqual(data, want)
	return err == nil && !equal
}

// current fetches Caddy's running config.
func (m *Manager) current(ctx context.Context) ([]byte, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.opts.AdminURL+"/config/", nil)
	if err != nil {
		return nil, false
	}
	resp, err := m.hc.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAdminBody))
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, false
	}
	return data, true
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
