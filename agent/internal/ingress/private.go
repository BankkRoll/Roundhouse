package ingress

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// Private DNS (ADR 0005, "Internal DNS"): the agent answers
// "<service>.<environment>.<project>.internal" on the node's mesh DNS
// address for the containers of the same environment, wherever the replicas
// run, and forwards every other name to the host's resolvers, since a
// container's HostConfig.Dns replaces Docker's upstream servers.

// PrivateTTL is the TTL of private answers: replicas move, so clients must
// ask again soon.
const PrivateTTL = 5

// DefaultForwardTimeout bounds one forwarded query.
const DefaultForwardTimeout = 2 * time.Second

// maxForwards bounds forwarded queries in flight; more are answered
// SERVFAIL rather than queued.
const maxForwards = 128

// PrivateRecord is one replica a private name resolves to.
type PrivateRecord struct {
	// Domain is the replica's "<service>.<environment>.<project>.internal".
	Domain string
	// EnvTag is the environment's net_tag; only askers of the same tag see
	// the record.
	EnvTag int
	// Addr is the replica's bridge IP when it runs on this node, its mesh IP
	// otherwise.
	Addr    netip.Addr
	Healthy bool
}

// PrivateZone is everything the private DNS answers from.
type PrivateZone struct {
	// Askers maps the bridge IP of every local container that has a mesh IP
	// to its environment's tag. Queries from any other source are refused.
	Askers  map[netip.Addr]int
	Records []PrivateRecord
}

// privateIndex is a [PrivateZone] indexed for lookups: FQDN, then env tag.
// It is replaced whole, never mutated.
type privateIndex struct {
	askers map[netip.Addr]int
	names  map[string]map[int][]PrivateRecord
}

func indexZone(z PrivateZone) *privateIndex {
	idx := &privateIndex{askers: z.Askers, names: map[string]map[int][]PrivateRecord{}}
	add := func(name string, r PrivateRecord) {
		byTag := idx.names[name]
		if byTag == nil {
			byTag = map[int][]PrivateRecord{}
			idx.names[name] = byTag
		}
		byTag[r.EnvTag] = append(byTag[r.EnvTag], r)
	}
	for _, r := range z.Records {
		d := strings.ToLower(strings.TrimSuffix(r.Domain, "."))
		labels := strings.Split(d, ".")
		if len(labels) != 4 || labels[3] != "internal" || !r.Addr.Is4() {
			continue
		}
		add(d+".", r)
		// The Phase 1 "<service>.<environment>.internal" form; the asker's
		// env tag stands in for the project.
		add(labels[0]+"."+labels[1]+".internal.", r)
	}
	for _, byTag := range idx.names {
		for tag, rs := range byTag {
			slices.SortFunc(rs, func(a, b PrivateRecord) int { return a.Addr.Compare(b.Addr) })
			byTag[tag] = slices.CompactFunc(rs, func(a, b PrivateRecord) bool { return a.Addr == b.Addr })
		}
	}
	return idx
}

// PrivateDNSOptions configures a [PrivateDNS].
type PrivateDNSOptions struct {
	// ResolvConf lists the upstream servers other names are forwarded to;
	// default /etc/resolv.conf. The agent runs in the host's network
	// namespace, so a stub like 127.0.0.53 works.
	ResolvConf string
	// Timeout bounds one forwarded query; default [DefaultForwardTimeout].
	Timeout time.Duration
	Logger  *slog.Logger
}

// PrivateDNS serves the private zone. Create it with [NewPrivateDNS], feed
// it with [PrivateDNS.SetZone] and start it with [PrivateDNS.Listen].
type PrivateDNS struct {
	opts  PrivateDNSOptions
	log   *slog.Logger
	zone  atomic.Pointer[privateIndex]
	rr    atomic.Uint32
	slots chan struct{}

	// listening is the address served, "" when none; readable without mu,
	// which Close holds while in-flight forwards finish.
	listening atomic.Pointer[string]

	mu   sync.Mutex
	addr string
	pc   net.PacketConn
	ln   net.Listener
	stop context.CancelFunc
	wg   sync.WaitGroup

	// upstreamPort is 53; tests point it at a fake resolver.
	upstreamPort string
	upMu         sync.Mutex
	upstreams    []string
	upRead       time.Time
}

// NewPrivateDNS returns a private DNS server that is not listening yet.
func NewPrivateDNS(opts PrivateDNSOptions) *PrivateDNS {
	if opts.ResolvConf == "" {
		opts.ResolvConf = "/etc/resolv.conf"
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultForwardTimeout
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	p := &PrivateDNS{opts: opts, log: log, slots: make(chan struct{}, maxForwards), upstreamPort: "53"}
	p.zone.Store(indexZone(PrivateZone{}))
	return p
}

// SetZone replaces what the server answers; it takes effect for the next
// query.
func (p *PrivateDNS) SetZone(z PrivateZone) { p.zone.Store(indexZone(z)) }

// Addr returns the "ip:port" the server listens on, "" when it doesn't.
func (p *PrivateDNS) Addr() string {
	if a := p.listening.Load(); a != nil {
		return *a
	}
	return ""
}

// Listen serves on addr ("ip:port", UDP and TCP) until [PrivateDNS.Close].
// Listening again on the same address is a no-op; on another, the old
// sockets close first.
func (p *PrivateDNS) Listen(addr string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.addr == addr && p.pc != nil {
		return nil
	}
	p.closeLocked()
	pc, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp4", addr)
	if err != nil {
		pc.Close()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.addr, p.pc, p.ln, p.stop = addr, pc, ln, cancel
	p.listening.Store(&addr)
	p.wg.Add(2)
	go func() {
		defer p.wg.Done()
		p.serveUDP(ctx, pc)
	}()
	go func() {
		defer p.wg.Done()
		p.serveTCP(ctx, ln)
	}()
	p.log.Info("private DNS listening", "addr", addr)
	return nil
}

// Close stops serving and waits for in-flight queries.
func (p *PrivateDNS) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeLocked()
}

func (p *PrivateDNS) closeLocked() {
	if p.pc == nil {
		return
	}
	p.listening.Store(nil)
	p.stop()
	p.pc.Close()
	p.ln.Close()
	p.wg.Wait()
	p.log.Info("private DNS stopped", "addr", p.addr)
	p.addr, p.pc, p.ln, p.stop = "", nil, nil, nil
}

func (p *PrivateDNS) serveUDP(ctx context.Context, pc net.PacketConn) {
	var wg sync.WaitGroup
	defer wg.Wait()
	buf := make([]byte, 1500)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			continue
		}
		src := addrOf(from)
		query := slices.Clone(buf[:n])
		out, fwd := p.answer(query, src, maxUDPAnswer)
		if fwd {
			select {
			case p.slots <- struct{}{}:
			default:
				p.reply(pc, from, servfail(query))
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-p.slots }()
				p.reply(pc, from, p.forward(ctx, query, false))
			}()
			continue
		}
		p.reply(pc, from, out)
	}
}

func (p *PrivateDNS) reply(pc net.PacketConn, to net.Addr, out []byte) {
	if out == nil {
		return
	}
	_ = pc.SetWriteDeadline(time.Now().Add(dnsIOTimeout))
	_, _ = pc.WriteTo(out, to)
}

func (p *PrivateDNS) serveTCP(ctx context.Context, ln net.Listener) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	conns := map[net.Conn]struct{}{}
	defer func() {
		mu.Lock()
		for c := range conns {
			c.Close()
		}
		mu.Unlock()
		wg.Wait()
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return
			}
			continue
		}
		mu.Lock()
		conns[c] = struct{}{}
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.serveConn(ctx, c)
			mu.Lock()
			delete(conns, c)
			mu.Unlock()
		}()
	}
}

// serveConn answers length-prefixed queries on one TCP connection.
func (p *PrivateDNS) serveConn(ctx context.Context, c net.Conn) {
	defer c.Close()
	src := addrOf(c.RemoteAddr())
	var size [2]byte
	for {
		_ = c.SetDeadline(time.Now().Add(dnsIOTimeout))
		if _, err := io.ReadFull(c, size[:]); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(size[:]))
		if n == 0 || n > maxDNSQuery {
			return
		}
		query := make([]byte, n)
		if _, err := io.ReadFull(c, query); err != nil {
			return
		}
		out, fwd := p.answer(query, src, 65535)
		if fwd {
			out = p.forward(ctx, query, true)
		}
		if out == nil {
			return
		}
		frame := binary.BigEndian.AppendUint16(make([]byte, 0, 2+len(out)), uint16(len(out)))
		_ = c.SetDeadline(time.Now().Add(dnsIOTimeout))
		if _, err := c.Write(append(frame, out...)); err != nil {
			return
		}
	}
}

func addrOf(a net.Addr) netip.Addr {
	switch v := a.(type) {
	case *net.UDPAddr:
		ip, _ := netip.AddrFromSlice(v.IP)
		return ip.Unmap()
	case *net.TCPAddr:
		ip, _ := netip.AddrFromSlice(v.IP)
		return ip.Unmap()
	}
	return netip.Addr{}
}

// answer builds the response to query from src, or reports that it must
// be forwarded (fwd); nil means drop the query.
//
// SECURITY: only local containers with a mesh IP may ask at all (REFUSED
// otherwise), so the server is never an open resolver and never forwards
// for anyone else. Private names are answered only within the asker's
// environment; a name of another environment is NXDOMAIN, exactly like a
// name that doesn't exist, so nothing leaks across environments.
func (p *PrivateDNS) answer(query []byte, src netip.Addr, maxSize int) (out []byte, fwd bool) {
	var parser dnsmessage.Parser
	h, err := parser.Start(query)
	if err != nil || h.Response {
		return nil, false
	}
	resp := dnsmessage.Header{ID: h.ID, Response: true, OpCode: h.OpCode, RecursionDesired: h.RecursionDesired}
	q, err := parser.Question()
	if err != nil || h.OpCode != 0 {
		resp.RCode = dnsmessage.RCodeFormatError
		if h.OpCode != 0 {
			resp.RCode = dnsmessage.RCodeNotImplemented
		}
		return build(resp, nil, nil, 0), false
	}
	idx := p.zone.Load()
	tag, known := idx.askers[src]
	if !known {
		resp.RCode = dnsmessage.RCodeRefused
		return build(resp, &q, nil, 0), false
	}
	name := strings.ToLower(q.Name.String())
	if name != "internal." && !strings.HasSuffix(name, ".internal.") {
		return nil, true
	}
	resp.Authoritative = true
	resp.RecursionAvailable = true
	recs := idx.names[name][tag]
	var answers []netip.Addr
	switch {
	case q.Class != dnsmessage.ClassINET:
		resp.RCode = dnsmessage.RCodeRefused
		resp.Authoritative = false
	case len(recs) == 0:
		resp.RCode = dnsmessage.RCodeNameError
	case q.Type == dnsmessage.TypeA:
		answers = p.pick(recs)
	}
	out = build(resp, &q, answers, PrivateTTL)
	if len(out) > maxSize {
		resp.Truncated = true
		out = build(resp, &q, nil, PrivateTTL)
	}
	return out, false
}

// pick returns the healthy replicas, or all of them when none is healthy
// so a client sees connection refused rather than a resolution failure,
// rotated per query to spread clients that take the first address.
func (p *PrivateDNS) pick(recs []PrivateRecord) []netip.Addr {
	var healthy, all []netip.Addr
	for _, r := range recs {
		all = append(all, r.Addr)
		if r.Healthy {
			healthy = append(healthy, r.Addr)
		}
	}
	out := healthy
	if len(out) == 0 {
		out = all
	}
	if len(out) > 1 {
		k := int(p.rr.Add(1)) % len(out)
		out = append(slices.Clone(out[k:]), out[:k]...)
	}
	return out
}

// servfail answers query with SERVFAIL, or returns nil for a query too
// malformed to answer.
func servfail(query []byte) []byte {
	var parser dnsmessage.Parser
	h, err := parser.Start(query)
	if err != nil {
		return nil
	}
	resp := dnsmessage.Header{ID: h.ID, Response: true, OpCode: h.OpCode, RecursionDesired: h.RecursionDesired,
		RCode: dnsmessage.RCodeServerFailure}
	if q, err := parser.Question(); err == nil {
		return build(resp, &q, nil, 0)
	}
	return build(resp, nil, nil, 0)
}

// forward relays query to the host's resolvers in turn, over TCP when the
// client asked over TCP, and returns the first valid response, or SERVFAIL.
func (p *PrivateDNS) forward(ctx context.Context, query []byte, tcp bool) []byte {
	if len(query) < 2 {
		return nil
	}
	id := binary.BigEndian.Uint16(query)
	for _, ns := range p.upstreamServers() {
		out, err := exchange(ctx, ns, query, tcp, p.opts.Timeout)
		if err != nil {
			p.log.Debug("forward DNS query", "upstream", ns, "err", err)
			continue
		}
		if len(out) >= 12 && binary.BigEndian.Uint16(out) == id && out[2]&0x80 != 0 {
			return out
		}
	}
	return servfail(query)
}

// exchange sends one query to server and reads its response.
func exchange(ctx context.Context, server string, query []byte, tcp bool, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	network := "udp"
	if tcp {
		network = "tcp"
	}
	var d net.Dialer
	c, err := d.DialContext(ctx, network, server)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	deadline, _ := ctx.Deadline()
	_ = c.SetDeadline(deadline)
	if !tcp {
		// NOTE: a connected UDP socket only accepts datagrams from server.
		if _, err := c.Write(query); err != nil {
			return nil, err
		}
		buf := make([]byte, 65535)
		n, err := c.Read(buf)
		if err != nil {
			return nil, err
		}
		return buf[:n], nil
	}
	frame := binary.BigEndian.AppendUint16(make([]byte, 0, 2+len(query)), uint16(len(query)))
	if _, err := c.Write(append(frame, query...)); err != nil {
		return nil, err
	}
	var size [2]byte
	if _, err := io.ReadFull(c, size[:]); err != nil {
		return nil, err
	}
	out := make([]byte, binary.BigEndian.Uint16(size[:]))
	if _, err := io.ReadFull(c, out); err != nil {
		return nil, err
	}
	return out, nil
}

// upstreamServers returns the nameservers of the resolv.conf, re-read at
// most every few seconds, without this server's own address (a loop).
func (p *PrivateDNS) upstreamServers() []string {
	p.upMu.Lock()
	defer p.upMu.Unlock()
	if !p.upRead.IsZero() && time.Since(p.upRead) < 5*time.Second {
		return p.upstreams
	}
	p.upRead = time.Now()
	p.upstreams = nil
	f, err := os.Open(p.opts.ResolvConf)
	if err != nil {
		p.log.Warn("read resolvers for private DNS forwarding", "path", p.opts.ResolvConf, "err", err)
		return nil
	}
	defer f.Close()
	self := p.Addr()
	for _, ns := range ParseNameservers(f) {
		addr := net.JoinHostPort(ns, p.upstreamPort)
		if addr != self {
			p.upstreams = append(p.upstreams, addr)
		}
	}
	return p.upstreams
}

// ParseNameservers returns the "nameserver" addresses of a resolv.conf,
// without IPv6 zones.
func ParseNameservers(r io.Reader) []string {
	var out []string
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		ip, err := netip.ParseAddr(fields[1])
		if err != nil {
			continue
		}
		out = append(out, ip.WithZone("").String())
	}
	return out
}
