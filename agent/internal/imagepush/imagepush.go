// Package imagepush answers image_push (ADR 0011, "Registry path"): it
// copies an image from the builder's local registry to a remote registry,
// such as Cloudflare's, with a login the control plane sealed to the node.
//
// Responsibilities:
//   - push only on builder nodes, and answer with the plaintext refusal on a
//     connection that refuses credential-bearing work;
//   - open the sealed login with the node key and use it only for the target
//     registry: never logged, written to disk, put in a result, or sent to
//     another host or over plain HTTP;
//   - copy registry to registry with the OCI distribution API, streaming
//     with no local unpack: select the linux/amd64 manifest of an index,
//     skip the blobs the target has, verify every digest, and push the
//     manifest's exact bytes to the target tag;
//   - authenticate with Basic or the Bearer token flow;
//   - enforce timeout_s, and answer a repeated push_id from the first push's
//     result instead of pushing again.
package imagepush

import (
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// NotBuilder is the error a node that doesn't run builds answers with.
const NotBuilder = "this node is not a builder"

// remembered is how many finished pushes are kept to answer a repeated
// push_id.
const remembered = 256

// sendTimeout bounds sending one result.
const sendTimeout = 10 * time.Second

// Options configure a [Pusher].
type Options struct {
	// NodeID is this node's ID, which the sealed login is bound to.
	NodeID string
	// Key is the node's X25519 key, which opens the sealed login.
	Key *ecdh.PrivateKey
	// Builder reports whether this node runs builds; only builders push.
	Builder bool
	// Refusal, when set, answers every push (conn.PlaintextRefusal).
	Refusal string
	// Send delivers a result to the control plane.
	Send func(ctx context.Context, r *protocol.ImagePushResult) error
	// Log, if set, receives progress lines under the push's task log
	// source. Lines never carry the login.
	Log func(pushID string, stream protocol.LogStream, text string)
	// Logger defaults to slog.Default().
	Logger *slog.Logger

	// SourceAddr replaces [protocol.RegistryListen] as the address the
	// source is read from. For tests.
	SourceAddr string
	// PlainHTTPHosts are target registry and token realm hosts reached
	// over http://. For tests; production pushes use https only.
	PlainHTTPHosts []string
	// Transport, if set, carries every request. For tests.
	Transport http.RoundTripper
}

// Pusher runs image pushes. Create it with [New].
type Pusher struct {
	opts   Options
	log    *slog.Logger
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu     sync.Mutex
	closed bool
	// pushes holds the result of each remembered push; nil while it runs.
	pushes map[string]*protocol.ImagePushResult
	// finished lists remembered pushes, oldest first.
	finished []string
}

// New returns a Pusher.
func New(opts Options) *Pusher {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.SourceAddr == "" {
		opts.SourceAddr = protocol.RegistryListen
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Pusher{opts: opts, log: opts.Logger, ctx: ctx, cancel: cancel,
		pushes: map[string]*protocol.ImagePushResult{}}
}

// Run waits for ctx to end, then stops the pushes in flight and waits for
// them to answer.
func (p *Pusher) Run(ctx context.Context) error {
	<-ctx.Done()
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.cancel()
	p.wg.Wait()
	return nil
}

// PushImage starts a push and returns at once; the result is sent when it
// ends. A push_id seen before is answered from its first push's result, or
// ignored while that push runs (its result is sent when it ends).
func (p *Pusher) PushImage(m *protocol.ImagePush) {
	p.mu.Lock()
	if res, ok := p.pushes[m.PushID]; ok {
		p.mu.Unlock()
		if res == nil {
			p.log.Info("image push already running", "push_id", m.PushID)
			return
		}
		p.log.Info("answering a repeated image push with its result", "push_id", m.PushID, "ok", res.OK)
		go p.send(res)
		return
	}
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.pushes[m.PushID] = nil
	p.wg.Add(1)
	p.mu.Unlock()
	go func() {
		defer p.wg.Done()
		res := p.push(m)
		p.mu.Lock()
		p.pushes[m.PushID] = res
		p.finished = append(p.finished, m.PushID)
		if len(p.finished) > remembered {
			delete(p.pushes, p.finished[0])
			p.finished = p.finished[1:]
		}
		p.mu.Unlock()
		p.send(res)
	}()
}

func (p *Pusher) send(res *protocol.ImagePushResult) {
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	if err := p.opts.Send(ctx, res); err != nil {
		p.log.Warn("send image push result; a repeated image_push gets it again", "push_id", res.PushID, "err", err)
	}
}

// push runs one push to its result.
func (p *Pusher) push(m *protocol.ImagePush) *protocol.ImagePushResult {
	log := p.log.With("push_id", m.PushID)
	fail := func(err error, secrets ...string) *protocol.ImagePushResult {
		msg := redact(err.Error(), secrets)
		log.Warn("image push failed", "target", m.Target, "err", msg)
		p.progress(m.PushID, protocol.StreamStderr, "push failed: "+msg)
		return &protocol.ImagePushResult{Type: protocol.TypeImagePushResult, PushID: m.PushID,
			Error: truncate(msg, protocol.MaxMessageBytes)}
	}
	if p.opts.Refusal != "" {
		return fail(errors.New(p.opts.Refusal))
	}
	if !p.opts.Builder {
		return fail(errors.New(NotBuilder))
	}
	src, srcDigest, ok := strings.Cut(strings.TrimPrefix(m.Source, protocol.RegistryListen+"/"), "@")
	host, rest, ok2 := strings.Cut(m.Target, "/")
	i := strings.LastIndexByte(rest, ':')
	if !ok || !ok2 || i <= 0 || !digestRE.MatchString(srcDigest) {
		return fail(errors.New("invalid source or target"))
	}
	dstRepo, tag := rest[:i], rest[i+1:]

	cred, err := protocol.OpenImagePushCredential(p.opts.Key, p.opts.NodeID, m)
	if err != nil {
		return fail(fmt.Errorf("open the registry credential: %w", err))
	}
	// NOTE: the login lives only in this push's authorizer, which nothing
	// keeps once the push returns; Go strings can't be wiped in place.
	plain := func(h string) bool { return slices.Contains(p.opts.PlainHTTPHosts, h) }
	srcRT, dstRT := p.opts.Transport, p.opts.Transport
	if srcRT == nil {
		srcRT, dstRT = sourceTransport(), targetTransport()
	}
	srcClient, dstClient := newClient(srcRT), newClient(dstRT)
	// NOTE: each push has its own transports; idle connections would
	// otherwise outlive it.
	defer srcClient.CloseIdleConnections()
	defer dstClient.CloseIdleConnections()
	auth := &authorizer{host: host, scope: "repository:" + dstRepo + ":pull,push",
		user: cred.Username, pass: cred.Password, plainRealm: plain, client: dstClient}
	cred = protocol.SealedImagePushCredential{}
	scheme := "https"
	if plain(host) {
		scheme = "http"
	}
	c := &copier{
		src:     &registry{scheme: "http", host: p.opts.SourceAddr, client: srcClient},
		dst:     &registry{scheme: scheme, host: host, client: dstClient, auth: auth},
		srcRepo: src, srcDig: srcDigest, dstRepo: dstRepo, dstTag: tag,
		progress: func(s string) { p.progress(m.PushID, protocol.StreamStdout, s) },
	}

	ctx, cancel := context.WithTimeout(p.ctx, time.Duration(m.TimeoutS)*time.Second)
	defer cancel()
	log.Info("image push started", "source", m.Source, "target", m.Target)
	p.progress(m.PushID, protocol.StreamStdout, fmt.Sprintf("pushing %s to %s", m.Source, m.Target))
	digest, err := c.run(ctx)
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			err = fmt.Errorf("the push did not finish within %d s: %w", m.TimeoutS, err)
		case p.ctx.Err() != nil:
			err = fmt.Errorf("the agent is shutting down: %w", err)
		}
		return fail(err, auth.secrets()...)
	}
	n := c.uploaded.Load()
	log.Info("image push finished", "target", m.Target, "digest", digest, "bytes", n)
	return &protocol.ImagePushResult{Type: protocol.TypeImagePushResult, PushID: m.PushID, OK: true,
		Digest: digest, Bytes: &n}
}

func (p *Pusher) progress(pushID string, stream protocol.LogStream, text string) {
	if p.opts.Log != nil {
		p.opts.Log(pushID, stream, text)
	}
}

// redact replaces every secret in s.
func redact(s string, secrets []string) string {
	for _, v := range secrets {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	return s
}

// truncate cuts s to at most n bytes on a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const ell = "…"
	s = s[:n-len(ell)]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + ell
}
