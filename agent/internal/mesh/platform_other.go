//go:build !linux

package mesh

import (
	"errors"
	"log/slog"
	"net/netip"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// errUnsupported is every host operation's answer off Linux, where the
// agent runs only for local development.
var errUnsupported = errors.New("the WireGuard mesh needs Linux")

type otherPlatform struct{}

func newPlatform(*slog.Logger) platform { return otherPlatform{} }

func (otherPlatform) Probe(string) protocol.MeshMode       { return protocol.MeshUnavailable }
func (otherPlatform) Up(string, int) (device, error)       { return nil, errUnsupported }
func (otherPlatform) EnsureDummy(string, netip.Addr) error { return errUnsupported }
func (otherPlatform) RemoveLink(string) error              { return nil }
func (otherPlatform) EnsureForwarding() error              { return errUnsupported }
func (otherPlatform) Client() (wgClient, error)            { return nil, errUnsupported }
