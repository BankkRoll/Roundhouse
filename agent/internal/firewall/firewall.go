// Package firewall holds the agent's iptables rules.
//
// Responsibilities:
//   - keep containers on the agent's bridge networks away from the cloud
//     metadata endpoint ([Rules]);
//   - enforce the TCP proxy's source allowlist on published ports
//     ([Publisher], ADR 0004 "TCP proxy").
//
// Cloud providers serve instance credentials and user data (which may hold
// the node's join token) at 169.254.169.254 (fd00:ec2::254 on AWS IPv6).
// Docker NATs container traffic out through the host, so without a rule any
// workload or build step could read them. The agent therefore inserts, for
// every roundhouse bridge interface, rules into Docker's DOCKER-USER chain
// rejecting traffic to those addresses (ADR 0014 H4). Rules are checked
// before they are added, so applying them again is a no-op.
package firewall

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
)

// Chain is Docker's chain for user rules, evaluated before Docker's own.
const Chain = "DOCKER-USER"

// Comment tags the agent's rules so operators can recognise them.
const Comment = "roundhouse: no cloud metadata"

// MetadataV4 and MetadataV6 are the cloud metadata endpoints.
const (
	MetadataV4 = "169.254.169.254/32"
	MetadataV6 = "fd00:ec2::254/128"
)

// Runner runs an iptables-family command and returns its combined output.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Rules installs the metadata rules. The zero value is not usable; create
// one with [New].
type Rules struct {
	run Runner
	log *slog.Logger

	mu sync.Mutex
	// done holds interfaces whose rules are in place.
	done map[string]bool
	// warned holds failures already logged, so a host without iptables (or
	// an agent without CAP_NET_ADMIN) warns once rather than per network.
	warned map[string]bool
}

// New returns rules that run commands with run; nil runs the host binaries.
func New(run Runner, log *slog.Logger) *Rules {
	if run == nil {
		run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).CombinedOutput()
		}
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Rules{run: run, log: log, done: map[string]bool{}, warned: map[string]bool{}}
}

// family is one address family's binary and endpoint.
type family struct{ bin, dest string }

var families = []family{{"iptables", MetadataV4}, {"ip6tables", MetadataV6}}

// Protect makes sure traffic entering from iface to the metadata endpoints
// is rejected, for IPv4 and IPv6. A family whose tooling or DOCKER-USER
// chain is missing is skipped with a warning, since a node must keep
// running workloads either way; the error reports what could not be
// installed.
func (r *Rules) Protect(ctx context.Context, iface string) error {
	if iface == "" || strings.ContainsAny(iface, " \t\n") || len(iface) > 15 {
		return fmt.Errorf("invalid interface name %q", iface)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done[iface] {
		return nil
	}
	var errs []error
	for _, f := range families {
		if err := r.ensure(ctx, f, iface); err != nil {
			errs = append(errs, err)
			if key := f.bin + ":" + firstLine(err.Error()); !r.warned[key] {
				r.warned[key] = true
				r.log.Warn("could not block the cloud metadata endpoint for containers; on a cloud server, workloads "+
					"may read instance credentials. Make sure iptables is installed and the agent has CAP_NET_ADMIN",
					"family", f.bin, "interface", iface, "err", err)
			}
		}
	}
	if len(errs) == 0 {
		r.done[iface] = true
	}
	return errors.Join(errs...)
}

// ensure inserts one rule unless it is already there. Caller holds r.mu.
func (r *Rules) ensure(ctx context.Context, f family, iface string) error {
	rule := ruleArgs(iface, f.dest)
	if _, err := r.run(ctx, f.bin, append([]string{"-w", "-C", Chain}, rule...)...); err == nil {
		return nil
	}
	// NOTE: -I, not -A: DOCKER-USER ends in Docker's own RETURN rule, so an
	// appended rule would never be reached.
	out, err := r.run(ctx, f.bin, append([]string{"-w", "-I", Chain, "1"}, rule...)...)
	if err != nil {
		return fmt.Errorf("%s: %w: %s", f.bin, err, strings.TrimSpace(string(out)))
	}
	r.log.Info("blocked the cloud metadata endpoint for containers", "family", f.bin, "interface", iface)
	return nil
}

// ruleArgs is the rule's match and target.
func ruleArgs(iface, dest string) []string {
	return []string{"-i", iface, "-d", dest, "-m", "comment", "--comment", Comment, "-j", "REJECT"}
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}
