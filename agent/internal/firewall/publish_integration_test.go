//go:build integration && linux

package firewall

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
)

// TestPublishAllowlistOnNetfilter runs [TestPublishAllowlistPrivileged] in a
// privileged sibling container with real iptables.
func TestPublishAllowlistOnNetfilter(t *testing.T) {
	c := dockertest.Client(t)
	// Distributions ship either flavour as "iptables"; iptables-restore
	// --noflush semantics must hold for both.
	for _, flavour := range []string{"nft", "legacy"} {
		t.Run(flavour, func(t *testing.T) {
			out := dockertest.RunPrivileged(t, c, dockertest.Privileged{
				Test:     "TestPublishAllowlistPrivileged",
				Packages: []string{"iptables", "iproute2"},
				Setup: "update-alternatives --set iptables /usr/sbin/iptables-" + flavour + "\n" +
					"update-alternatives --set ip6tables /usr/sbin/ip6tables-" + flavour,
			})
			t.Log(out)
		})
	}
}

// TestPublishAllowlistPrivileged emulates a Docker host inside network
// namespaces: a "container" behind a DNAT from host port 20001 (the FORWARD
// path through DOCKER-USER), a host listener on 20002 standing in for
// docker-proxy (the INPUT path), and two clients with different sources.
func TestPublishAllowlistPrivileged(t *testing.T) {
	dockertest.SkipUnlessPrivileged(t)
	t.Log(strings.TrimSpace(sh(t, "iptables -V")))
	if out, err := exec.Command("bash", "-c", "iptables -w -S && ip6tables -w -S").CombinedOutput(); err != nil {
		t.Skipf("this kernel does not support this iptables flavour: %s", out)
	}
	sh(t, `
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1 net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.default.disable_ipv6=0
for ns in rhctr rhcli1 rhcli2; do ip netns add $ns; ip netns exec $ns ip link set lo up; done
ip link add rhctr-h type veth peer name eth0 netns rhctr
ip link add rhcli1-h type veth peer name eth0 netns rhcli1
ip link add rhcli2-h type veth peer name eth0 netns rhcli2
ip addr add 10.99.0.1/24 dev rhctr-h;  ip link set rhctr-h up
ip addr add 10.98.1.1/24 dev rhcli1-h; ip -6 addr add fd00:98:1::1/64 dev rhcli1-h nodad; ip link set rhcli1-h up
ip addr add 10.98.2.1/24 dev rhcli2-h; ip -6 addr add fd00:98:2::1/64 dev rhcli2-h nodad; ip link set rhcli2-h up
ip netns exec rhctr  sh -c 'ip addr add 10.99.0.2/24 dev eth0; ip link set eth0 up; ip route add default via 10.99.0.1'
ip netns exec rhcli1 sh -c 'sysctl -qw net.ipv6.conf.all.disable_ipv6=0; ip addr add 10.98.1.2/24 dev eth0; ip -6 addr add fd00:98:1::2/64 dev eth0 nodad; ip link set eth0 up; ip route add default via 10.98.1.1; ip -6 route add default via fd00:98:1::1'
ip netns exec rhcli2 sh -c 'sysctl -qw net.ipv6.conf.all.disable_ipv6=0; ip addr add 10.98.2.2/24 dev eth0; ip -6 addr add fd00:98:2::2/64 dev eth0 nodad; ip link set eth0 up; ip route add default via 10.98.2.1; ip -6 route add default via fd00:98:2::1'
iptables -w -t nat -A PREROUTING -m addrtype --dst-type LOCAL -p tcp --dport 20001 -j DNAT --to-destination 10.99.0.2:5432
for t in iptables ip6tables; do $t -w -N DOCKER-USER; $t -w -A DOCKER-USER -j RETURN; $t -w -A FORWARD -j DOCKER-USER; done
`)

	accepted := &atomic.Int64{}
	serve(t, listenIn(t, "rhctr", "tcp4", ":5432"), accepted)
	serve(t, listenIn(t, "", "tcp4", ":20002"), accepted)
	serve(t, listenIn(t, "", "tcp6", "[::]:20003"), accepted)
	// A server elsewhere that happens to use a published port number; the
	// container's own connections to it must never hit the allowlist.
	serve(t, listenIn(t, "rhcli2", "tcp4", ":20001"), accepted)

	viaDNAT, viaInput, viaInput6 := "10.98.%d.1:20001", "10.98.%d.1:20002", "[fd00:98:%d::1]:20003"
	for _, addr := range []string{viaDNAT, viaInput, viaInput6} {
		for cli := 1; cli <= 2; cli++ {
			mustReach(t, cli, fmt.Sprintf(addr, cli))
		}
	}

	p := NewPublisher(nil, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx := context.Background()
	if err := p.Probe(ctx); err != nil {
		t.Fatalf("probe: %v", err)
	}
	apply := func(cli1, cli2 bool) {
		t.Helper()
		var v4, v6 []string
		if cli1 {
			v4, v6 = append(v4, "10.98.1.0/24"), append(v6, "fd00:98:1::/64")
		}
		if cli2 {
			v4, v6 = append(v4, "10.98.2.2/32"), append(v6, "fd00:98:2::2/128")
		}
		st := p.Apply(ctx, []PublishedPort{
			{HostPort: 20001, Allowed: v4, Owner: "wl_it_dnat"},
			{HostPort: 20002, Allowed: v4, Owner: "wl_it_proxy"},
			{HostPort: 20003, IPv6: true, Allowed: append(v4, v6...), Owner: "wl_it_v6"},
		})
		if st.Enforced(true) != nil {
			t.Fatalf("apply: %+v", st)
		}
	}

	apply(true, false)
	established := dialIn(t, "rhcli1", "10.98.1.1:20001")
	defer established.Close()
	if err := roundTrip(established); err != nil {
		t.Fatalf("established connection before the edit: %v", err)
	}
	for _, addr := range []string{viaDNAT, viaInput, viaInput6} {
		mustReach(t, 1, fmt.Sprintf(addr, 1))
		mustNotReach(t, 2, fmt.Sprintf(addr, 2))
	}
	if _, err := tryDial("rhctr", "10.98.2.2:20001"); err != nil {
		t.Fatalf("the container's outbound connection to a remote port 20001 was dropped: %v", err)
	}

	before := accepted.Load()
	apply(false, true)
	for _, addr := range []string{viaDNAT, viaInput, viaInput6} {
		mustNotReach(t, 1, fmt.Sprintf(addr, 1))
		mustReach(t, 2, fmt.Sprintf(addr, 2))
	}
	if accepted.Load() <= before {
		t.Fatal("the listeners stopped accepting after the edit")
	}
	if err := roundTrip(established); err == nil {
		t.Fatal("a connection from a removed source kept working after the edit")
	}

	// Repeated applies keep exactly one jump per chain and family.
	p.Invalidate()
	apply(false, true)
	for _, bin := range []string{"iptables", "ip6tables"} {
		for _, chain := range []string{Chain, "INPUT"} {
			if n := strings.Count(sh(t, bin+" -w -S "+chain), "-j "+PublishChain); n != 1 {
				t.Fatalf("%s %s has %d jumps to %s", bin, chain, n, PublishChain)
			}
		}
	}
	if got := sh(t, "iptables -w -S "+PublishChain); !strings.Contains(got, `--comment "roundhouse: tcp proxy wl_it_dnat"`) {
		t.Fatalf("chain:\n%s", got)
	}

	// A firewall flush (as on a reboot or reload) is repaired on the next
	// verify.
	sh(t, "iptables -w -D INPUT ! -i lo -m comment --comment 'roundhouse: tcp proxy' -j "+PublishChain)
	mustReach(t, 1, fmt.Sprintf(viaInput, 1))
	p.Invalidate()
	apply(false, true)
	mustNotReach(t, 1, fmt.Sprintf(viaInput, 1))

	if st := p.Apply(ctx, nil); st.Enforced(true) != nil {
		t.Fatal(st)
	}
	for _, addr := range []string{viaDNAT, viaInput, viaInput6} {
		mustReach(t, 1, fmt.Sprintf(addr, 1))
	}
}

func sh(t *testing.T, script string) string {
	t.Helper()
	out, err := exec.Command("bash", "-ec", script).CombinedOutput()
	if err != nil {
		t.Fatalf("%s\n%v: %s", script, err, out)
	}
	return string(out)
}

// inNetns runs fn on a thread inside the named network namespace ("" for
// the current one). A socket keeps the namespace it was created in.
func inNetns(name string, fn func() error) error {
	if name == "" {
		return fn()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	orig, err := os.Open("/proc/thread-self/ns/net")
	if err != nil {
		return err
	}
	defer orig.Close()
	target, err := os.Open("/var/run/netns/" + name)
	if err != nil {
		return err
	}
	defer target.Close()
	if err := unix.Setns(int(target.Fd()), unix.CLONE_NEWNET); err != nil {
		return err
	}
	defer func() {
		if err := unix.Setns(int(orig.Fd()), unix.CLONE_NEWNET); err != nil {
			panic(err)
		}
	}()
	return fn()
}

func listenIn(t *testing.T, ns, network, addr string) net.Listener {
	t.Helper()
	var ln net.Listener
	err := inNetns(ns, func() (err error) {
		ln, err = net.Listen(network, addr)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln
}

// serve echoes every line back.
func serve(t *testing.T, ln net.Listener, accepted *atomic.Int64) {
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if _, err := c.Write([]byte(line)); err != nil {
						return
					}
				}
			}()
		}
	}()
}

func tryDial(ns, addr string) (net.Conn, error) {
	var c net.Conn
	err := inNetns(ns, func() (err error) {
		c, err = net.DialTimeout("tcp", addr, 2*time.Second)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := roundTrip(c); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func dialIn(t *testing.T, ns, addr string) net.Conn {
	t.Helper()
	c, err := tryDial(ns, addr)
	if err != nil {
		t.Fatalf("%s → %s: %v", ns, addr, err)
	}
	return c
}

func roundTrip(c net.Conn) error {
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := c.Write([]byte("ping\n")); err != nil {
		return err
	}
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		return err
	}
	if line != "ping\n" {
		return fmt.Errorf("echo %q", line)
	}
	return nil
}

func mustReach(t *testing.T, cli int, addr string) {
	t.Helper()
	c, err := tryDial(fmt.Sprintf("rhcli%d", cli), addr)
	if err != nil {
		t.Fatalf("client %d could not reach %s: %v", cli, addr, err)
	}
	c.Close()
}

func mustNotReach(t *testing.T, cli int, addr string) {
	t.Helper()
	if c, err := tryDial(fmt.Sprintf("rhcli%d", cli), addr); err == nil {
		c.Close()
		t.Fatalf("client %d reached %s, which its source is not allowed to", cli, addr)
	}
}
