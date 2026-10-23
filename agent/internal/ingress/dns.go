package ingress

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// DefaultDNSListen is where the upstream DNS server listens. Caddy, on the
// same host, resolves every route's upstreams through it.
const DefaultDNSListen = "127.0.0.1:2021"

// UpstreamZone is the zone the upstream DNS server answers for. ".invalid"
// is reserved (RFC 6761), so no public resolver ever answers for it and a
// name in it can never leave the node.
const UpstreamZone = "upstreams.openrail.invalid."

const (
	// maxUDPAnswer is the classic DNS UDP payload limit. A larger answer is
	// sent truncated and the resolver retries over TCP.
	maxUDPAnswer = 512
	dnsIOTimeout = 5 * time.Second
	maxDNSQuery  = 512
)

// dnsTable maps lowercase FQDNs in [UpstreamZone] to their A records. It is
// replaced whole, never mutated, so readers need no lock.
type dnsTable map[string][]netip.Addr

// dnsServer answers A queries for [UpstreamZone] from the latest table.
type dnsServer struct {
	table atomic.Pointer[dnsTable]
}

func newDNSServer() *dnsServer {
	s := &dnsServer{}
	empty := dnsTable{}
	s.table.Store(&empty)
	return s
}

func (s *dnsServer) set(t dnsTable) { s.table.Store(&t) }

func (s *dnsServer) get() dnsTable { return *s.table.Load() }

// answer builds the response to one query message, or nil when the query
// is too malformed to answer at all. maxSize bounds the response; a larger
// one is replaced by an empty truncated answer.
//
// It answers authoritatively for [UpstreamZone]: A records for a known name
// (TTL 0, since Caddy caches by its own refresh interval), an empty NOERROR
// for other types of a known name, NXDOMAIN for unknown names in the zone,
// and REFUSED for anything outside it, so it can never be used as an open
// resolver.
func (s *dnsServer) answer(query []byte, maxSize int) []byte {
	var p dnsmessage.Parser
	h, err := p.Start(query)
	if err != nil || h.Response {
		return nil
	}
	resp := dnsmessage.Header{
		ID:               h.ID,
		Response:         true,
		OpCode:           h.OpCode,
		Authoritative:    true,
		RecursionDesired: h.RecursionDesired,
	}
	q, err := p.Question()
	if err != nil || h.OpCode != 0 {
		resp.RCode = dnsmessage.RCodeFormatError
		if h.OpCode != 0 {
			resp.RCode = dnsmessage.RCodeNotImplemented
		}
		resp.Authoritative = false
		return build(resp, nil, nil)
	}
	name := strings.ToLower(q.Name.String())
	var answers []netip.Addr
	switch {
	case q.Class != dnsmessage.ClassINET || (name != UpstreamZone && !strings.HasSuffix(name, "."+UpstreamZone)):
		resp.RCode = dnsmessage.RCodeRefused
		resp.Authoritative = false
	default:
		addrs, ok := s.get()[name]
		switch {
		case !ok && name != UpstreamZone:
			resp.RCode = dnsmessage.RCodeNameError
		case q.Type == dnsmessage.TypeA:
			answers = addrs
		}
	}
	out := build(resp, &q, answers)
	if len(out) > maxSize {
		resp.Truncated = true
		out = build(resp, &q, nil)
	}
	return out
}

func build(h dnsmessage.Header, q *dnsmessage.Question, answers []netip.Addr) []byte {
	b := dnsmessage.NewBuilder(make([]byte, 0, 512), h)
	b.EnableCompression()
	if q != nil {
		_ = b.StartQuestions()
		_ = b.Question(*q)
		_ = b.StartAnswers()
		for _, a := range answers {
			if !a.Is4() {
				continue
			}
			_ = b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 0},
				dnsmessage.AResource{A: a.As4()})
		}
	}
	out, err := b.Finish()
	if err != nil {
		return nil
	}
	return out
}

// ListenDNS opens the UDP socket and TCP listener the upstream DNS server
// serves on. addr must be a loopback address: the answers describe the
// node's containers and only the local Caddy needs them.
func ListenDNS(addr string) (net.PacketConn, net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, nil, err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, nil, errors.New("upstream DNS must listen on a loopback IP, got " + addr)
	}
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, nil, err
	}
	ln, err := net.Listen("tcp", pc.LocalAddr().String())
	if err != nil {
		pc.Close()
		return nil, nil, err
	}
	return pc, ln, nil
}

// ServeDNSOn answers upstream lookups on pc (UDP) and ln (TCP, either may be
// nil) until ctx ends, then closes them.
func (m *Manager) ServeDNSOn(ctx context.Context, pc net.PacketConn, ln net.Listener) error {
	var wg sync.WaitGroup
	errc := make(chan error, 2)
	if pc != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errc <- m.serveUDP(pc)
		}()
	}
	if ln != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errc <- m.serveTCP(ctx, ln)
		}()
	}
	var err error
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	if pc != nil {
		pc.Close()
	}
	if ln != nil {
		ln.Close()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func (m *Manager) serveUDP(pc net.PacketConn) error {
	buf := make([]byte, 1500)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		if out := m.dns.answer(buf[:n], maxUDPAnswer); out != nil {
			_ = pc.SetWriteDeadline(time.Now().Add(dnsIOTimeout))
			_, _ = pc.WriteTo(out, addr)
		}
	}
}

func (m *Manager) serveTCP(ctx context.Context, ln net.Listener) error {
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		conns = map[net.Conn]struct{}{}
	)
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
				return nil
			}
			return err
		}
		mu.Lock()
		conns[c] = struct{}{}
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.serveDNSConn(c)
			mu.Lock()
			delete(conns, c)
			mu.Unlock()
		}()
	}
}

// serveDNSConn answers length-prefixed queries on one TCP connection until
// the client closes it or goes quiet.
func (m *Manager) serveDNSConn(c net.Conn) {
	defer c.Close()
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
		out := m.dns.answer(query, 65535)
		if out == nil {
			return
		}
		frame := binary.BigEndian.AppendUint16(make([]byte, 0, 2+len(out)), uint16(len(out)))
		if _, err := c.Write(append(frame, out...)); err != nil {
			return
		}
	}
}
