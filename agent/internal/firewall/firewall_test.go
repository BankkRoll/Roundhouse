package firewall

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

// fakeTables is an in-memory DOCKER-USER chain per binary.
type fakeTables struct {
	rules   map[string][]string // bin -> rules, joined args
	missing map[string]bool     // bins that fail every call
	calls   []string
}

func (f *fakeTables) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if f.missing[name] {
		return []byte("iptables: No chain/target/match by that name."), errors.New("exit status 1")
	}
	if args[0] != "-w" {
		return nil, errors.New("missing -w")
	}
	switch args[1] {
	case "-C":
		if slices.Contains(f.rules[name], strings.Join(args[3:], " ")) {
			return nil, nil
		}
		return []byte("Bad rule"), errors.New("exit status 1")
	case "-I":
		if args[2] != Chain || args[3] != "1" {
			return nil, errors.New("rules must be inserted at the top of DOCKER-USER")
		}
		f.rules[name] = append([]string{strings.Join(args[4:], " ")}, f.rules[name]...)
		return nil, nil
	}
	return nil, errors.New("unexpected " + args[1])
}

func TestProtectIsIdempotent(t *testing.T) {
	f := &fakeTables{rules: map[string][]string{}}
	r := New(f.run, nil)
	for range 2 {
		if err := r.Protect(context.Background(), "rh-0123456789a"); err != nil {
			t.Fatal(err)
		}
	}
	if err := New(f.run, nil).Protect(context.Background(), "rh-0123456789a"); err != nil {
		t.Fatal(err)
	}
	for bin, dest := range map[string]string{"iptables": MetadataV4, "ip6tables": MetadataV6} {
		rules := f.rules[bin]
		want := "-i rh-0123456789a -d " + dest + " -m comment --comment " + Comment + " -j REJECT"
		if len(rules) != 1 || rules[0] != want {
			t.Errorf("%s rules %q, want exactly [%q]", bin, rules, want)
		}
	}
}

func TestProtectEachInterface(t *testing.T) {
	f := &fakeTables{rules: map[string][]string{}}
	r := New(f.run, nil)
	for _, iface := range []string{"roundhouse-bk0", "br-0123456789ab", "rh-abc"} {
		if err := r.Protect(context.Background(), iface); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(f.rules["iptables"]); n != 3 {
		t.Fatalf("%d IPv4 rules, want 3", n)
	}
}

func TestProtectWithoutIPv6StillBlocksIPv4(t *testing.T) {
	f := &fakeTables{rules: map[string][]string{}, missing: map[string]bool{"ip6tables": true}}
	r := New(f.run, nil)
	if err := r.Protect(context.Background(), "rh-a"); err == nil {
		t.Fatal("a missing family must be reported")
	}
	if len(f.rules["iptables"]) != 1 {
		t.Fatalf("IPv4 rules %v", f.rules["iptables"])
	}
	// Not marked done, so a later attempt (say after Docker enables IPv6)
	// retries the missing family without duplicating the other.
	delete(f.missing, "ip6tables")
	if err := r.Protect(context.Background(), "rh-a"); err != nil {
		t.Fatal(err)
	}
	if len(f.rules["iptables"]) != 1 || len(f.rules["ip6tables"]) != 1 {
		t.Fatalf("rules %v", f.rules)
	}
}

func TestProtectRejectsBadInterfaces(t *testing.T) {
	r := New((&fakeTables{rules: map[string][]string{}}).run, nil)
	for _, bad := range []string{"", "a b", "much-too-long-interface"} {
		if err := r.Protect(context.Background(), bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
