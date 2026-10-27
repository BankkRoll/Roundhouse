package netpol

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// Runner runs a command with stdin (nil for none) and returns its combined
// output.
type Runner func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error)

// ExecRunner runs host binaries.
func ExecRunner(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	return cmd.CombinedOutput()
}

// DockerUserChain is Docker's iptables chain for user rules.
const DockerUserChain = "DOCKER-USER"

// markComment tags the DOCKER-USER rule so operators can recognise it.
const markComment = "roundhouse: mesh"

// Firewall applies the table and the DOCKER-USER mark rule. Create it with
// [NewFirewall]; it is safe for concurrent use.
type Firewall struct {
	run Runner
	log *slog.Logger

	mu sync.Mutex
	// applied is the script nft last accepted, "" when the table is not
	// known to be in place.
	applied string
}

// NewFirewall returns a firewall that runs commands with run; nil runs the
// host binaries.
func NewFirewall(run Runner, log *slog.Logger) *Firewall {
	if run == nil {
		run = ExecRunner
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Firewall{run: run, log: log}
}

// Apply replaces the table with script unless nft already runs exactly it
// and the table still exists. The replacement is one nft transaction, so
// packets never see a half-built table.
func (f *Firewall) Apply(ctx context.Context, script string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.applied == script && f.present(ctx) {
		return nil
	}
	out, err := f.run(ctx, []byte(script), "nft", "-f", "-")
	if err != nil {
		f.applied = ""
		return fmt.Errorf("nft: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if f.applied == "" {
		f.log.Info("applied the nftables table")
	}
	f.applied = script
	return nil
}

// present reports whether the table exists. Caller holds f.mu.
func (f *Firewall) present(ctx context.Context) bool {
	_, err := f.run(ctx, nil, "nft", "list", "table", "inet", "roundhouse")
	return err == nil
}

// Remove deletes the table; a missing table is not an error.
func (f *Firewall) Remove(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applied = ""
	if !f.present(ctx) {
		return nil
	}
	if out, err := f.run(ctx, nil, "nft", "delete", "table", "inet", "roundhouse"); err != nil {
		return fmt.Errorf("nft delete table: %w: %s", err, strings.TrimSpace(string(out)))
	}
	f.log.Info("removed the nftables table")
	return nil
}

// markRule is the DOCKER-USER rule accepting packets that carry mark.
func markRule(mark uint32) []string {
	m := fmt.Sprintf("0x%x/0x%x", mark, mark)
	return []string{"-m", "mark", "--mark", m, "-m", "comment", "--comment", markComment, "-j", "ACCEPT"}
}

// EnsureMarkRule makes sure the first rule of DOCKER-USER accepts packets
// carrying mark, for Docker's iptables backend. It reads the chain first,
// so calling it on every reconcile is cheap, and puts the rule back after a
// Docker restart recreated the chain.
//
// NOTE: first, not merely present: other rules inserted at the top of
// DOCKER-USER (the TCP proxy's ROUNDHOUSE-PUBLISH jump, which takes every
// DNATed connection and matches on the original destination port) must not
// see mesh traffic, which our table already admitted and DNATed.
func (f *Firewall) EnsureMarkRule(ctx context.Context, mark uint32) error {
	rule := markRule(mark)
	out, err := f.run(ctx, nil, "iptables", "-w", "-S", DockerUserChain)
	if err != nil {
		return fmt.Errorf("iptables -S %s: %w: %s", DockerUserChain, err, strings.TrimSpace(string(out)))
	}
	want := fmt.Sprintf("--mark 0x%x/0x%x", mark, mark)
	first := ""
	for line := range strings.Lines(string(out)) {
		if strings.HasPrefix(line, "-A "+DockerUserChain+" ") {
			first = line
			break
		}
	}
	if strings.Contains(first, want) && strings.Contains(first, markComment) && strings.Contains(first, "-j ACCEPT") {
		return nil
	}
	f.RemoveMarkRule(ctx, mark)
	// NOTE: -I, not -A: DOCKER-USER ends in Docker's own RETURN rule.
	out, err = f.run(ctx, nil, "iptables", append([]string{"-w", "-I", DockerUserChain, "1"}, rule...)...)
	if err != nil {
		return fmt.Errorf("iptables -I %s: %w: %s", DockerUserChain, err, strings.TrimSpace(string(out)))
	}
	f.log.Info("Docker now accepts packets carrying the mesh mark", "chain", DockerUserChain, "mark", fmt.Sprintf("%#x", mark))
	return nil
}

// CheckDockerUser reports why [Firewall.EnsureMarkRule] could not work:
// no iptables, no DOCKER-USER chain (Docker isn't running on the iptables
// backend), or no CAP_NET_ADMIN. It changes nothing.
func (f *Firewall) CheckDockerUser(ctx context.Context) error {
	out, err := f.run(ctx, nil, "iptables", "-w", "-S", DockerUserChain)
	if err != nil {
		return fmt.Errorf("iptables -S %s: %w: %s", DockerUserChain, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// RemoveMarkRule deletes the DOCKER-USER rule for mark, if present.
func (f *Firewall) RemoveMarkRule(ctx context.Context, mark uint32) {
	rule := markRule(mark)
	for range 8 {
		if _, err := f.run(ctx, nil, "iptables", append([]string{"-w", "-D", DockerUserChain}, rule...)...); err != nil {
			return
		}
	}
}

// Backend is Docker's firewall backend.
type Backend string

// Firewall backends.
const (
	BackendIPTables Backend = "iptables"
	BackendNFTables Backend = "nftables"
)

// ParseBackend maps the engine's /info FirewallBackend.Driver ("iptables",
// "iptables+firewalld", "nftables", ...) to a backend. Engines before
// Docker 28 report none and use iptables.
func ParseBackend(driver string) Backend {
	if strings.Contains(strings.ToLower(driver), "nftables") {
		return BackendNFTables
	}
	return BackendIPTables
}

// MarkFix is the remedy shown when an nftables-backend daemon doesn't
// accept the mesh mark.
func MarkFix(mark uint32) string {
	return fmt.Sprintf(`add "bridge-accept-fwmark": "0x%x/0x%x" to /etc/docker/daemon.json and restart Docker (Docker 29 or later)`, mark, mark)
}

// ErrMarkUnknown means the daemon's bridge-accept-fwmark setting could not
// be found.
var ErrMarkUnknown = errors.New("cannot tell whether Docker accepts the mesh mark")

// DaemonAcceptsMark reports whether an nftables-backend Docker daemon
// accepts packets carrying mark: its bridge-accept-fwmark, from the
// dockerd command line (cmdlines, each a process's argv) or else from
// daemon.json (nil when absent), must match mark|anything. Without either
// it returns [ErrMarkUnknown].
func DaemonAcceptsMark(daemonJSON []byte, cmdlines [][]string, mark uint32) (bool, error) {
	value, found := "", false
	for _, argv := range cmdlines {
		if len(argv) == 0 || !strings.HasSuffix(argv[0], "dockerd") {
			continue
		}
		for i, a := range argv[1:] {
			if v, ok := strings.CutPrefix(a, "--bridge-accept-fwmark="); ok {
				value, found = v, true
			} else if a == "--bridge-accept-fwmark" && i+2 < len(argv) {
				value, found = argv[i+2], true
			}
		}
	}
	if !found && daemonJSON != nil {
		var cfg map[string]any
		if err := json.Unmarshal(daemonJSON, &cfg); err != nil {
			return false, fmt.Errorf("daemon.json: %w", err)
		}
		if v, ok := cfg["bridge-accept-fwmark"].(string); ok {
			value, found = v, true
		}
	}
	if !found {
		return false, ErrMarkUnknown
	}
	return markAccepted(value, mark), nil
}

// markAccepted reports whether Docker's "value[/mask]" accepts every packet
// whose mark has the bits of mark set: the mask may only cover mark's bits,
// and value must equal mark under it.
func markAccepted(setting string, mark uint32) bool {
	v, m, hasMask := strings.Cut(setting, "/")
	value, err := strconv.ParseUint(v, 0, 32)
	if err != nil {
		return false
	}
	mask := uint64(0xffff_ffff)
	if hasMask {
		if mask, err = strconv.ParseUint(m, 0, 32); err != nil {
			return false
		}
	}
	return mask != 0 && mask&^uint64(mark) == 0 && value&mask == uint64(mark)&mask
}
