package certs

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
)

// EventKind is what a Caddy tls log line says about a hostname.
type EventKind int

// Event kinds.
const (
	// EventPending: Caddy started obtaining a certificate.
	EventPending EventKind = iota + 1
	// EventObtained: Caddy obtained or renewed one.
	EventObtained
	// EventFailed: an attempt failed; Caddy may retry.
	EventFailed
)

// Event is one parsed Caddy tls log line.
type Event struct {
	Host string
	Kind EventKind
	// Renewal is set for the tls.renew logger: a valid certificate may
	// still be in place.
	Renewal bool
	// Error is set for [EventFailed].
	Error string
}

// logLine is the part of Caddy's JSON log entry that is read. Caddy's
// certificate maintenance (certmagic) logs under tls.obtain, tls.renew and
// tls.on_demand; the hostname is "identifier", or "server_name" for
// on-demand.
type logLine struct {
	Logger     string `json:"logger"`
	Msg        string `json:"msg"`
	Identifier string `json:"identifier"`
	ServerName string `json:"server_name"`
	Error      string `json:"error"`
}

// ParseEvent reads one JSON log line written by Caddy 2.11 (certmagic
// 0.25). It understands:
//
//	tls.obtain    "obtaining certificate"                 identifier  → pending
//	tls.on_demand "obtaining new certificate"             server_name → pending
//	tls.obtain    "certificate obtained successfully"     identifier  → obtained
//	tls.renew     "certificate renewed successfully"      identifier  → obtained
//	tls.obtain/renew "could not get certificate from issuer" identifier, error → failed
//	tls.obtain/renew "will retry", "final attempt; giving up" error "[host] Obtain: …" → failed
func ParseEvent(line []byte) (Event, bool) {
	var l logLine
	if err := json.Unmarshal(line, &l); err != nil {
		return Event{}, false
	}
	renewal := false
	switch l.Logger {
	case "tls.obtain", "tls.on_demand":
	case "tls.renew":
		renewal = true
	default:
		return Event{}, false
	}
	host := l.Identifier
	var ev Event
	switch l.Msg {
	case "obtaining certificate":
		ev.Kind = EventPending
	case "obtaining new certificate":
		ev.Kind, host = EventPending, l.ServerName
	case "certificate obtained successfully", "certificate renewed successfully":
		ev.Kind = EventObtained
	case "could not get certificate from issuer":
		ev.Kind, ev.Error = EventFailed, l.Error
	case "will retry", "final attempt; giving up":
		// The retry loop logs only the error, which certmagic prefixes
		// with "[<name>] Obtain: " or "[<name>] Renew: ".
		rest, ok := strings.CutPrefix(l.Error, "[")
		name, _, found := strings.Cut(rest, "] ")
		if !ok || !found {
			return Event{}, false
		}
		ev.Kind, ev.Error, host = EventFailed, l.Error, name
	default:
		return Event{}, false
	}
	if ev.Kind == EventFailed && ev.Error == "" {
		ev.Error = l.Msg
	}
	ev.Host = strings.ToLower(strings.TrimSuffix(host, "."))
	ev.Renewal = renewal
	if ev.Host == "" {
		return Event{}, false
	}
	return ev, true
}

// maxLogLine bounds one log line; certmagic errors carry ACME problem
// documents, which are small.
const maxLogLine = 64 << 10

// maxLogConns bounds concurrent log connections. Caddy opens one per
// writer.
const maxLogConns = 4

// ListenLog listens on addr, which must be a loopback address like the ask
// endpoint's: only Caddy on this host may report events.
//
// SECURITY: any local process can connect to a loopback port, so events
// only ever move a host to pending or failed, or trigger a handshake; only
// a handshake proves a certificate issued.
func ListenLog(addr string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("tls log listener must be on a loopback IP, got %q", addr)
	}
	return net.Listen("tcp", addr)
}

// ServeLogOn reads Caddy's tls log lines from connections on ln and hands
// each event to handle, until ctx ends.
func ServeLogOn(ctx context.Context, ln net.Listener, handle func(Event)) error {
	var wg sync.WaitGroup
	var mu sync.Mutex
	conns := map[net.Conn]struct{}{}
	stop := context.AfterFunc(ctx, func() {
		_ = ln.Close()
		mu.Lock()
		for c := range conns {
			_ = c.Close()
		}
		mu.Unlock()
	})
	defer stop()
	defer wg.Wait()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		mu.Lock()
		if len(conns) >= maxLogConns || ctx.Err() != nil {
			mu.Unlock()
			_ = c.Close()
			continue
		}
		conns[c] = struct{}{}
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				mu.Lock()
				delete(conns, c)
				mu.Unlock()
				_ = c.Close()
			}()
			readLog(c, handle)
		}()
	}
}

func readLog(c net.Conn, handle func(Event)) {
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 0, 4096), maxLogLine)
	for sc.Scan() {
		if ev, ok := ParseEvent(sc.Bytes()); ok {
			handle(ev)
		}
	}
}
