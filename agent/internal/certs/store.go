// Package certs holds the agent's side of custom domains and TLS (ADR 0009).
//
// Responsibilities:
//   - [Store], for managed mode: verify certificates the control plane ships
//     in cert_sync, write them where Caddy can read them, hand them to the
//     ingress manager, acknowledge them once Caddy has loaded them, request
//     what the desired state's manifest lists but the node lacks, and prune
//     what it no longer lists;
//   - [Tracker], for hosts Caddy issues on demand (acme mode, and managed
//     mode before a host's certificate exists): follow Caddy's tls logs,
//     trigger issuance with a TLS handshake, and report each host's
//     certificate in cert_status.
package certs

import (
	"cmp"
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// DefaultDir is where certificate files live on Linux. It is outside the
// agent's 0700 data directory because Caddy, running as its own user, must
// read them; install.sh creates it root:caddy 2750 so every file written in
// it is group caddy.
const DefaultDir = "/var/lib/roundhouse-certs"

// DefaultGroup is the group Caddy's Debian package runs it as.
const DefaultGroup = "caddy"

// Request backoff for manifest entries the control plane has not supplied.
const (
	minRequestDelay = 30 * time.Second
	maxRequestDelay = 10 * time.Minute
	// checkInterval is how often requests and acknowledgements are retried.
	checkInterval = 30 * time.Second
	sendTimeout   = 10 * time.Second
	// syncQueue bounds cert_sync frames waiting to be processed; beyond it
	// a frame is dropped and its certificates are requested again.
	syncQueue = 16
)

// Ingress is the part of the ingress manager the store drives;
// *ingress.Manager implements it.
type Ingress interface {
	SetCertificates(ctx context.Context, certs []ingress.Certificate) error
}

// StoreOptions configures a [Store].
type StoreOptions struct {
	// Dir holds the certificate files, one "<id>.pem" each (chain, then
	// key), mode 0640.
	Dir string
	// Group owns Dir and its files so Caddy can read them; "" means
	// [DefaultGroup]. If the group does not exist (Caddy runs as root, or
	// on a development machine) files stay owner-only.
	Group string
	// IndexPath records which certificates are on disk, with their digests
	// and the latest manifest, so a restarted agent serves them before its
	// first desired state. It belongs in the agent's private data directory.
	IndexPath string
	// NodeID and Key open sealed private keys.
	NodeID string
	Key    *ecdh.PrivateKey
	// Ingress receives the set of certificate files to load.
	Ingress Ingress
	// Send writes cert_ack and cert_request frames.
	Send func(ctx context.Context, m protocol.AgentMessage) error
	// Enabled reports whether the control plane speaks
	// [protocol.CertsProtocolVersion]; nothing is sent before it does.
	Enabled func() bool
	// Logger receives certificate events; nil discards them.
	Logger *slog.Logger
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
}

// entry is a certificate file on disk, as recorded in the index.
type entry struct {
	SHA256    string   `json:"sha256"`
	Hostnames []string `json:"hostnames"`
	NotAfter  int64    `json:"not_after"`
	// FileSHA256 is the digest of the whole file, which detects a file
	// changed or truncated behind the agent's back.
	FileSHA256 string `json:"file_sha256"`
}

// index is the persisted state.
type index struct {
	// Manifest is the latest desired_state.certificates, by ID; nil until
	// one arrived.
	Manifest map[string]string `json:"manifest"`
	Certs    map[string]entry  `json:"certs"`
}

// request tracks re-requests of one manifest entry.
type request struct {
	next  time.Time
	delay time.Duration
}

// Store keeps the node's certificate files equal to the control plane's
// manifest (managed mode). Create it with [NewStore], then call
// [Store.Run]; its other methods may be called from any goroutine and never
// block.
type Store struct {
	opts StoreOptions
	log  *slog.Logger

	syncs chan *protocol.CertSync
	wake  chan struct{}

	mu sync.Mutex
	// held are the verified files Caddy should load.
	held map[string]entry
	// manifest is nil until a desired state (or the index) gave one.
	manifest map[string]string
	// manifestChanged is set until Run has pruned for the latest manifest.
	manifestChanged bool
	// loaded is what Caddy runs, by ID, once known.
	loaded      map[string]string
	loadedKnown bool
	// acked is what has been acknowledged on this connection.
	acked map[string]string
	// stale are files no longer held, deleted once Caddy no longer loads
	// them.
	stale    map[string]bool
	requests map[string]*request
	dirty    bool

	// The rest is owned by the goroutine running [Store.Run].

	// requestBudget and ackBudget pace frames by wall-clock time, whatever
	// [StoreOptions].Now says.
	requestBudget, ackBudget frameBudget
	// retry wakes Run when a budget allows the frames it held back.
	retry *time.Timer
}

// NewStore prepares the directory (a failure is logged, not returned) and restores the certificates recorded
// in the index that are still intact, unexpired and in the persisted
// manifest, and hands them to the ingress manager. Files the index does not
// account for are removed once Caddy is known not to load them.
func NewStore(opts StoreOptions) (*Store, error) {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	opts.Group = cmp.Or(opts.Group, DefaultGroup)
	s := &Store{
		opts:     opts,
		log:      opts.Logger,
		syncs:    make(chan *protocol.CertSync, syncQueue),
		wake:     make(chan struct{}, 1),
		held:     map[string]entry{},
		acked:    map[string]string{},
		stale:    map[string]bool{},
		requests: map[string]*request{},
		loaded:   map[string]string{},

		requestBudget: frameBudget{per: requestsPerSecond},
		ackBudget:     frameBudget{per: acksPerSecond},
	}
	if s.log == nil {
		s.log = slog.New(slog.DiscardHandler)
	}
	// NOTE: only managed TLS mode needs the directory; without it the
	// agent runs on and every certificate write is logged as failing.
	if err := prepareDir(opts.Dir, opts.Group, s.log); err != nil {
		s.log.Error("certificates directory unavailable; managed TLS certificates cannot be stored", "dir", opts.Dir, "err", err)
	}
	s.restore()
	s.push(context.Background())
	return s, nil
}

// restore loads the index and keeps the entries whose files still verify.
func (s *Store) restore() {
	var idx index
	data, err := os.ReadFile(s.opts.IndexPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		s.log.Warn("read certificate index; requesting certificates again", "path", s.opts.IndexPath, "err", err)
	default:
		if err := json.Unmarshal(data, &idx); err != nil {
			s.log.Warn("certificate index is corrupt; requesting certificates again", "path", s.opts.IndexPath, "err", err)
			idx = index{}
		}
	}
	s.manifest = idx.Manifest
	now := s.opts.Now()
	for id, e := range idx.Certs {
		if _, ok := s.manifest[id]; s.manifest != nil && !ok {
			s.stale[id] = true
			continue
		}
		if err := s.check(id, e, now); err != nil {
			s.log.Warn("dropping certificate restored from disk", "certificate_id", id, "err", err)
			s.stale[id] = true
			continue
		}
		s.held[id] = e
	}
	entries, err := os.ReadDir(s.opts.Dir)
	if err != nil {
		return
	}
	for _, de := range entries {
		name := de.Name()
		if id, ok := strings.CutSuffix(name, ".pem"); ok && !strings.HasPrefix(name, ".") {
			if _, held := s.held[id]; !held {
				s.stale[id] = true
			}
		} else if strings.HasPrefix(name, ".") && strings.Contains(name, ".tmp-") {
			_ = os.Remove(filepath.Join(s.opts.Dir, name))
		}
	}
}

// check verifies a file recorded in the index.
func (s *Store) check(id string, e entry, now time.Time) error {
	if !validID(id) {
		return errors.New("invalid id")
	}
	data, err := os.ReadFile(s.path(id))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != e.FileSHA256 {
		return errors.New("file changed on disk")
	}
	if _, err := tls.X509KeyPair(data, data); err != nil {
		return err
	}
	if now.UnixMilli() >= e.NotAfter {
		return errors.New("expired")
	}
	return nil
}

func validID(id string) bool {
	return (&protocol.CertAck{IDs: []string{id}}).Validate() == nil
}

func (s *Store) path(id string) string { return filepath.Join(s.opts.Dir, id+".pem") }

// SyncCerts queues a verified cert_sync frame. A frame that does not fit
// the queue is dropped; the next manifest check requests its certificates
// again.
func (s *Store) SyncCerts(m *protocol.CertSync) {
	select {
	case s.syncs <- m:
	default:
		s.log.Warn("certificate sync queue full; dropping frame", "msg_id", m.ID)
	}
}

// SetManifest records the certificates the latest desired state lists; nil
// lists none. Certificates it does not list are removed, and those it lists
// that the node lacks, or holds with another digest, are requested.
func (s *Store) SetManifest(refs []protocol.CertificateRef) {
	m := make(map[string]string, len(refs))
	for _, r := range refs {
		m[r.ID] = r.SHA256
	}
	s.mu.Lock()
	if s.manifest == nil || !maps.Equal(m, s.manifest) {
		s.manifest = m
		s.manifestChanged = true
		s.dirty = true
	}
	s.mu.Unlock()
	s.poke()
}

// Loaded records what Caddy runs; pass it [ingress.Options].OnLoaded.
func (s *Store) Loaded(l ingress.Loaded) {
	s.mu.Lock()
	s.loaded = maps.Clone(l.Certificates)
	if s.loaded == nil {
		s.loaded = map[string]string{}
	}
	s.loadedKnown = true
	s.mu.Unlock()
	s.poke()
}

// Connected starts over on a new connection, or once the control plane is
// known to speak [protocol.CertsProtocolVersion]: every loaded certificate
// is acknowledged again and missing ones requested at once.
func (s *Store) Connected() {
	s.mu.Lock()
	clear(s.acked)
	clear(s.requests)
	s.mu.Unlock()
	s.poke()
}

func (s *Store) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run processes cert_sync frames and keeps acknowledgements, requests and
// files up to date until ctx ends.
func (s *Store) Run(ctx context.Context) error {
	t := time.NewTicker(checkInterval)
	defer t.Stop()
	defer func() {
		if s.retry != nil {
			s.retry.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case m := <-s.syncs:
			// PERF: a cert_request is answered with several frames; applying
			// all that arrived together costs one Caddy load, not one each.
			batch := []*protocol.CertSync{m}
			for more := true; more; {
				select {
				case m := <-s.syncs:
					batch = append(batch, m)
				default:
					more = false
				}
			}
			s.apply(ctx, batch...)
			s.housekeep(ctx)
		case <-s.wake:
			s.housekeep(ctx)
		case <-t.C:
			s.housekeep(ctx)
		}
	}
}

// apply verifies and writes the frames' upserts, drops their removes, and
// hands the new set to Caddy once.
func (s *Store) apply(ctx context.Context, frames ...*protocol.CertSync) {
	changed := false
	for _, m := range frames {
		if s.applyOne(m) {
			changed = true
		}
	}
	// NOTE: the index goes to disk before Caddy may load a file, so a file
	// Caddy loads is never an orphan to a restarted agent.
	s.persist()
	if changed {
		s.push(ctx)
	}
}

// applyOne verifies and writes one frame's upserts and drops its removes,
// reporting whether the held set changed.
func (s *Store) applyOne(m *protocol.CertSync) bool {
	now := s.opts.Now()
	changed := false
	for i := range m.Upserts {
		u := &m.Upserts[i]
		s.mu.Lock()
		cur, ok := s.held[u.ID]
		s.mu.Unlock()
		if ok && cur.SHA256 == u.SHA256 {
			continue
		}
		v, err := Verify(s.opts.Key, s.opts.NodeID, u, now)
		if err != nil {
			s.log.Error("rejecting certificate from the control plane", "certificate_id", u.ID, "err", err)
			continue
		}
		// NOTE: 0640 rather than ADR 0009's 0600: Caddy runs as its own user
		// and reads the file through the directory's caddy group.
		if err := atomicfile.Write(s.path(v.ID), v.File, 0o640); err != nil {
			s.log.Error("write certificate", "certificate_id", v.ID, "err", err)
			continue
		}
		sum := sha256.Sum256(v.File)
		s.mu.Lock()
		s.held[v.ID] = entry{SHA256: v.SHA256, Hostnames: v.Hostnames, NotAfter: v.NotAfter.UnixMilli(), FileSHA256: hex.EncodeToString(sum[:])}
		delete(s.stale, v.ID)
		s.dirty = true
		s.mu.Unlock()
		changed = true
		s.log.Info("certificate stored", "certificate_id", v.ID, "hostnames", v.Hostnames, "renewal", ok,
			"not_after", v.NotAfter.UTC().Format(time.RFC3339))
	}
	for _, id := range m.Removes {
		s.mu.Lock()
		if _, ok := s.held[id]; ok {
			delete(s.held, id)
			s.stale[id] = true
			s.dirty = true
			changed = true
		}
		s.mu.Unlock()
	}
	return changed
}

// push hands the held certificates to the ingress manager.
func (s *Store) push(ctx context.Context) {
	if s.opts.Ingress == nil {
		return
	}
	s.mu.Lock()
	certs := make([]ingress.Certificate, 0, len(s.held))
	for id, e := range s.held {
		certs = append(certs, ingress.Certificate{ID: id, Path: s.path(id), SHA256: e.SHA256})
	}
	s.mu.Unlock()
	if err := s.opts.Ingress.SetCertificates(ctx, certs); err != nil && ctx.Err() == nil {
		s.log.Debug("certificate load failed; the ingress manager retries", "err", err)
	}
}

// housekeep prunes for a new manifest, deletes files Caddy no longer
// loads, and sends acknowledgements and requests.
func (s *Store) housekeep(ctx context.Context) {
	s.mu.Lock()
	prune := s.manifestChanged
	s.manifestChanged = false
	if prune {
		for id := range s.held {
			if _, ok := s.manifest[id]; !ok {
				delete(s.held, id)
				s.stale[id] = true
				s.dirty = true
			}
		}
	}
	s.mu.Unlock()
	s.persist()
	if prune {
		s.push(ctx)
	}
	s.deleteStale()
	s.ack(ctx)
	s.request(ctx)
}

// deleteStale removes files Caddy is known not to load.
func (s *Store) deleteStale() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.loadedKnown {
		return
	}
	for id := range s.stale {
		if _, ok := s.loaded[id]; ok {
			continue
		}
		if err := os.Remove(s.path(id)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("remove certificate", "certificate_id", id, "err", err)
			continue
		}
		delete(s.stale, id)
		s.log.Info("certificate removed", "certificate_id", id)
	}
}

// ack acknowledges every held certificate Caddy runs with the held digest,
// if that is the digest the manifest lists.
//
// NOTE: cert_ack carries IDs only, so acknowledging a certificate the
// manifest has since renewed could confirm the renewal before Caddy loads
// it, e.g. when the re-acknowledgement after a reconnect races it.
func (s *Store) ack(ctx context.Context) {
	if s.opts.Send == nil || (s.opts.Enabled != nil && !s.opts.Enabled()) {
		return
	}
	s.mu.Lock()
	var ids []string
	for id, e := range s.held {
		if want, listed := s.manifest[id]; s.manifest != nil && (!listed || want != e.SHA256) {
			continue
		}
		if s.loaded[id] == e.SHA256 && s.acked[id] != e.SHA256 {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	slices.Sort(ids)
	for chunk := range slices.Chunk(ids, protocol.MaxCertIDsPerFrame) {
		if ok, wait := s.ackBudget.take(time.Now()); !ok {
			s.retryIn(wait)
			return
		}
		if err := s.send(ctx, &protocol.CertAck{Type: protocol.TypeCertAck, IDs: chunk}); err != nil {
			return
		}
		s.mu.Lock()
		for _, id := range chunk {
			s.acked[id] = s.held[id].SHA256
		}
		s.mu.Unlock()
		s.log.Debug("acknowledged certificates", "certificate_ids", chunk)
	}
}

// request asks for manifest entries the node lacks or holds with another
// digest, backing off per ID while they stay missing.
func (s *Store) request(ctx context.Context) {
	if s.opts.Send == nil || (s.opts.Enabled != nil && !s.opts.Enabled()) {
		return
	}
	now := s.opts.Now()
	s.mu.Lock()
	var ids []string
	for id, sha := range s.manifest {
		if s.held[id].SHA256 == sha {
			delete(s.requests, id)
			continue
		}
		r := s.requests[id]
		if r == nil {
			r = &request{delay: minRequestDelay}
			s.requests[id] = r
		}
		if now.Before(r.next) {
			continue
		}
		ids = append(ids, id)
	}
	for id := range s.requests {
		if _, ok := s.manifest[id]; !ok {
			delete(s.requests, id)
		}
	}
	s.mu.Unlock()
	if len(ids) == 0 {
		return
	}
	slices.Sort(ids)
	for chunk := range slices.Chunk(ids, requestChunk) {
		// IDs held back stay due, so the next pass asks for them.
		if ok, wait := s.requestBudget.take(time.Now()); !ok {
			s.retryIn(wait)
			return
		}
		if err := s.send(ctx, &protocol.CertRequest{Type: protocol.TypeCertRequest, IDs: chunk}); err != nil {
			return
		}
		s.mu.Lock()
		for _, id := range chunk {
			if r := s.requests[id]; r != nil {
				r.next = now.Add(r.delay)
				r.delay = min(r.delay*2, maxRequestDelay)
			}
		}
		s.mu.Unlock()
		s.log.Info("requested certificates", "certificate_ids", chunk)
	}
}

// retryIn wakes [Store.Run] after d, for frames a budget held back.
func (s *Store) retryIn(d time.Duration) {
	if s.retry != nil {
		s.retry.Stop()
	}
	s.retry = time.AfterFunc(d, s.poke)
}

func (s *Store) send(ctx context.Context, m protocol.AgentMessage) error {
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return s.opts.Send(ctx, m)
}

// persist writes the index if it changed.
func (s *Store) persist() {
	s.mu.Lock()
	if !s.dirty || s.opts.IndexPath == "" {
		s.mu.Unlock()
		return
	}
	data, err := json.Marshal(index{Manifest: s.manifest, Certs: s.held})
	s.dirty = false
	s.mu.Unlock()
	if err == nil {
		err = atomicfile.Write(s.opts.IndexPath, data, 0o600)
	}
	if err != nil {
		s.log.Error("persist certificate index", "path", s.opts.IndexPath, "err", err)
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
	}
}

// Held returns the IDs and digests of the certificates on disk.
func (s *Store) Held() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.held))
	for id, e := range s.held {
		out[id] = e.SHA256
	}
	return out
}
