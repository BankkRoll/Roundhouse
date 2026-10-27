package certs

import (
	"cmp"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// Defaults applied when the corresponding [TrackerOptions] field is zero.
const (
	DefaultHTTPSAddr        = "127.0.0.1:443"
	DefaultHandshakeTimeout = time.Minute
	DefaultProbeConcurrency = 4
	DefaultRecheckInterval  = 12 * time.Hour
)

// TrackerOptions configures a [Tracker].
type TrackerOptions struct {
	// HTTPSAddr is Caddy's HTTPS listener as seen from the agent.
	HTTPSAddr string
	// Send writes cert_status frames.
	Send func(ctx context.Context, m protocol.AgentMessage) error
	// Enabled reports whether the control plane speaks
	// [protocol.CertsProtocolVersion]; nothing is sent before it does.
	Enabled func() bool
	// Logger receives probe failures; nil discards them.
	Logger *slog.Logger
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
	// HandshakeTimeout bounds one probe. On-demand issuance happens inside
	// the first handshake, so it must allow for an ACME order.
	HandshakeTimeout time.Duration
	// Concurrency bounds simultaneous probes.
	Concurrency int
	// Recheck is how often an issued host is probed again, jittered by
	// ±10%, to pick up renewals.
	Recheck time.Duration
	// Probe fetches the leaf Caddy serves for host; nil makes a TLS
	// handshake to HTTPSAddr with host as SNI.
	Probe func(ctx context.Context, host string) (*x509.Certificate, error)
}

// hostState is what the tracker knows about one hostname.
type hostState struct {
	// state is "" until something is known.
	state    protocol.CertState
	issuer   string
	notAfter *int64
	err      string
	// sent is the last status sent on this connection.
	sent *protocol.CertStatus
	// queued is set while a probe is waiting or running.
	queued    bool
	nextCheck time.Time
}

// Tracker reports the certificates Caddy issues on demand for the hosts it
// may issue for (acme mode, and managed mode before the control plane's
// certificate exists), as cert_status frames: once per change, and all of
// them again after a reconnect. Create it with [NewTracker], feed it
// [Tracker.Loaded] and [Tracker.HandleEvent], and call [Tracker.Run].
type Tracker struct {
	opts TrackerOptions
	log  *slog.Logger

	wake   chan struct{}
	probes chan struct{}

	mu     sync.Mutex
	active bool
	hosts  map[string]*hostState
	// pending are hosts waiting for a probe, in order.
	pending []string
	// dirty are hosts whose status may need sending.
	dirty map[string]bool

	// budget paces cert_status frames by wall-clock time; owned by the
	// goroutine that flushes.
	budget frameBudget
	// retry wakes [Tracker.Run] when budget allows the frames it held back.
	retry *time.Timer
}

// NewTracker returns a tracker with no hosts.
func NewTracker(opts TrackerOptions) *Tracker {
	opts.HTTPSAddr = cmp.Or(opts.HTTPSAddr, DefaultHTTPSAddr)
	opts.HandshakeTimeout = cmp.Or(opts.HandshakeTimeout, DefaultHandshakeTimeout)
	opts.Concurrency = cmp.Or(opts.Concurrency, DefaultProbeConcurrency)
	opts.Recheck = cmp.Or(opts.Recheck, DefaultRecheckInterval)
	if opts.Now == nil {
		opts.Now = time.Now
	}
	t := &Tracker{
		opts:   opts,
		log:    opts.Logger,
		wake:   make(chan struct{}, 1),
		probes: make(chan struct{}, 1),
		hosts:  map[string]*hostState{},
		dirty:  map[string]bool{},
		budget: frameBudget{per: statusesPerSecond},
	}
	if t.log == nil {
		t.log = slog.New(slog.DiscardHandler)
	}
	if t.opts.Probe == nil {
		t.opts.Probe = t.handshake
	}
	return t
}

// Loaded takes the hosts of a config Caddy accepted; pass it
// [ingress.Options].OnLoaded. New hosts are probed, which makes Caddy issue
// at once; hosts no longer listed are forgotten.
func (t *Tracker) Loaded(l ingress.Loaded) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.active = l.TLSMode == protocol.TLSACME || l.TLSMode == protocol.TLSManaged
	want := map[string]bool{}
	if t.active {
		for _, h := range l.Hosts {
			if protocol.IsRouteHostname(h) && !strings.HasPrefix(h, "*.") {
				want[h] = true
			}
		}
	}
	for h := range t.hosts {
		if !want[h] {
			delete(t.hosts, h)
			delete(t.dirty, h)
		}
	}
	t.pending = slices.DeleteFunc(t.pending, func(h string) bool { return !want[h] })
	for h := range want {
		if _, ok := t.hosts[h]; !ok {
			t.hosts[h] = &hostState{}
			t.enqueue(h)
		}
	}
}

// HandleEvent applies a Caddy tls log event to its host, if tracked.
func (t *Tracker) HandleEvent(ev Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.hosts[ev.Host]
	if s == nil {
		return
	}
	switch ev.Kind {
	case EventPending:
		if s.state != protocol.CertIssued {
			t.set(ev.Host, s, protocol.CertPending, "", nil, "")
		}
	case EventObtained:
		// NOTE: the log names the ACME directory, not the CA; the leaf from
		// a handshake has the issuer and expiry, and proves the issuance.
		t.enqueue(ev.Host)
	case EventFailed:
		if ev.Renewal && s.state == protocol.CertIssued && s.notAfter != nil && t.opts.Now().UnixMilli() < *s.notAfter {
			t.log.Warn("certificate renewal failed; the current certificate is still valid", "hostname", ev.Host, "err", ev.Error)
			return
		}
		t.set(ev.Host, s, protocol.CertFailed, "", nil, ev.Error)
	}
}

// Connected sends every host's status again: call it on each new
// connection and when the control plane is known to speak
// [protocol.CertsProtocolVersion].
func (t *Tracker) Connected() {
	t.mu.Lock()
	for h, s := range t.hosts {
		s.sent = nil
		t.dirty[h] = true
	}
	t.mu.Unlock()
	t.poke(t.wake)
}

// Status returns the current status of host, if tracked and known.
func (t *Tracker) Status(host string) (protocol.CertStatus, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.hosts[host]
	if s == nil || s.state == "" {
		return protocol.CertStatus{}, false
	}
	return status(host, s), true
}

// set records a host's status and marks it for sending. Caller holds t.mu.
func (t *Tracker) set(host string, s *hostState, state protocol.CertState, issuer string, notAfter *int64, errText string) {
	s.state, s.issuer, s.notAfter, s.err = state, issuer, notAfter, truncate(errText, protocol.MaxMessageBytes)
	t.dirty[host] = true
	t.poke(t.wake)
}

// enqueue schedules a probe of host. Caller holds t.mu.
func (t *Tracker) enqueue(host string) {
	s := t.hosts[host]
	if s == nil || s.queued {
		return
	}
	s.queued = true
	t.pending = append(t.pending, host)
	t.poke(t.probes)
}

func (t *Tracker) poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

// Run sends statuses, probes hosts and schedules re-checks until ctx ends.
func (t *Tracker) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	defer wg.Wait()
	for range t.opts.Concurrency {
		wg.Go(func() { t.probeLoop(ctx) })
	}
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	defer func() {
		if t.retry != nil {
			t.retry.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.wake:
			t.flush(ctx)
		case <-tick.C:
			t.recheck()
			t.flush(ctx)
		}
	}
}

// recheck queues hosts whose re-check is due.
func (t *Tracker) recheck() {
	now := t.opts.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for h, s := range t.hosts {
		if !s.nextCheck.IsZero() && !now.Before(s.nextCheck) {
			t.enqueue(h)
		}
	}
}

func (t *Tracker) probeLoop(ctx context.Context) {
	for {
		t.mu.Lock()
		var host string
		if len(t.pending) > 0 {
			host, t.pending = t.pending[0], t.pending[1:]
		}
		more := len(t.pending) > 0
		t.mu.Unlock()
		if host == "" {
			select {
			case <-ctx.Done():
				return
			case <-t.probes:
				continue
			}
		}
		if more {
			// Hand the rest to an idle worker.
			t.poke(t.probes)
		}
		t.probe(ctx, host)
		if ctx.Err() != nil {
			return
		}
	}
}

// probe makes one handshake for host and records what Caddy served.
func (t *Tracker) probe(ctx context.Context, host string) {
	pctx, cancel := context.WithTimeout(ctx, t.opts.HandshakeTimeout)
	leaf, err := t.opts.Probe(pctx, host)
	cancel()
	if ctx.Err() != nil {
		return
	}
	now := t.opts.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.hosts[host]
	if s == nil {
		return
	}
	s.queued = false
	jitter := time.Duration((rand.Float64()*0.2 - 0.1) * float64(t.opts.Recheck))
	s.nextCheck = now.Add(t.opts.Recheck + jitter)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		// Issuance may still be running inside Caddy; its log reports the
		// outcome, and the next check probes again.
		if s.state == "" {
			t.set(host, s, protocol.CertPending, "", nil, "")
		}
	case err != nil:
		t.log.Debug("certificate probe failed", "hostname", host, "err", err)
		if s.state != protocol.CertFailed {
			t.set(host, s, protocol.CertFailed, "", nil, "TLS handshake failed: "+err.Error())
		}
	case !Covers(leaf, host):
		t.set(host, s, protocol.CertFailed, "", nil, "the certificate served does not cover "+host)
	case !now.Before(leaf.NotAfter):
		t.set(host, s, protocol.CertFailed, "", nil, "the certificate served expired at "+leaf.NotAfter.UTC().Format(time.RFC3339))
	default:
		na := leaf.NotAfter.UnixMilli()
		if s.state != protocol.CertIssued || s.notAfter == nil || *s.notAfter != na || s.issuer != issuerName(leaf) {
			t.set(host, s, protocol.CertIssued, issuerName(leaf), &na, "")
		}
	}
}

// handshake connects to Caddy with host as SNI and returns the leaf.
//
// NOTE: verification is skipped on purpose: this asks what Caddy serves,
// including an untrusted or wrong certificate, which the caller judges.
func (t *Tracker) handshake(ctx context.Context, host string) (*x509.Certificate, error) {
	d := tls.Dialer{
		NetDialer: &net.Dialer{},
		Config:    &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, //nolint:gosec // see NOTE
	}
	c, err := d.DialContext(ctx, "tcp", t.opts.HTTPSAddr)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	certs := c.(*tls.Conn).ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, errors.New("no certificate")
	}
	return certs[0], nil
}

// flush sends the statuses that changed since they were last sent.
func (t *Tracker) flush(ctx context.Context) {
	if t.opts.Send == nil || (t.opts.Enabled != nil && !t.opts.Enabled()) {
		return
	}
	t.mu.Lock()
	if !t.active {
		clear(t.dirty)
		t.mu.Unlock()
		return
	}
	var out []protocol.CertStatus
	for h := range t.dirty {
		s := t.hosts[h]
		delete(t.dirty, h)
		if s == nil || s.state == "" {
			continue
		}
		st := status(h, s)
		if s.sent != nil && equalStatus(*s.sent, st) {
			continue
		}
		out = append(out, st)
	}
	t.mu.Unlock()
	slices.SortFunc(out, func(a, b protocol.CertStatus) int { return strings.Compare(a.Hostname, b.Hostname) })
	for i := range out {
		st := out[i]
		if err := st.Validate(); err != nil {
			t.log.Warn("not sending invalid cert_status", "hostname", st.Hostname, "err", err)
			continue
		}
		if ok, wait := t.budget.take(time.Now()); !ok {
			t.mu.Lock()
			for _, rest := range out[i:] {
				t.dirty[rest.Hostname] = true
			}
			t.mu.Unlock()
			if t.retry != nil {
				t.retry.Stop()
			}
			t.retry = time.AfterFunc(wait, func() { t.poke(t.wake) })
			return
		}
		sctx, cancel := context.WithTimeout(ctx, sendTimeout)
		err := t.opts.Send(sctx, &st)
		cancel()
		t.mu.Lock()
		if err != nil {
			// Connected resends everything after a reconnect.
			t.mu.Unlock()
			return
		}
		if s := t.hosts[st.Hostname]; s != nil {
			s.sent = &st
		}
		t.mu.Unlock()
	}
}

func status(host string, s *hostState) protocol.CertStatus {
	st := protocol.CertStatus{Type: protocol.TypeCertStatus, Hostname: host, State: s.state}
	switch s.state {
	case protocol.CertIssued:
		st.Issuer, st.NotAfter = s.issuer, s.notAfter
	case protocol.CertFailed:
		st.Error = cmp.Or(s.err, "certificate issuance failed")
	}
	return st
}

func equalStatus(a, b protocol.CertStatus) bool {
	na := func(p *int64) int64 {
		if p == nil {
			return -1
		}
		return *p
	}
	return a.Hostname == b.Hostname && a.State == b.State && a.Issuer == b.Issuer && a.Error == b.Error &&
		na(a.NotAfter) == na(b.NotAfter)
}

// issuerName names a leaf's issuer by organisation and common name, such
// as "Let's Encrypt R11".
func issuerName(leaf *x509.Certificate) string {
	var parts []string
	if len(leaf.Issuer.Organization) > 0 {
		parts = append(parts, leaf.Issuer.Organization[0])
	}
	if cn := leaf.Issuer.CommonName; cn != "" && !slices.Contains(parts, cn) {
		parts = append(parts, cn)
	}
	return truncate(strings.Join(parts, " "), 256)
}

// truncate returns valid UTF-8 of at most n bytes.
func truncate(s string, n int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
