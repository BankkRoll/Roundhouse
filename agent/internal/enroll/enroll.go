// Package enroll performs the one-time join handshake that turns a fresh host
// into a registered node: it creates the node's identity and encryption keys,
// exchanges a join token for a credential, and writes the resulting config.
//
// A join either fully succeeds or leaves any previous registration intact.
// Each registration writes its keys, credential and state under
// names unique to it, and the atomic config write that points at them is
// the only commit point; the previous registration's files are removed only
// after that write.
package enroll

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/BankkRoll/Roundhouse/agent/internal/clock"
	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/facts"
	"github.com/BankkRoll/Roundhouse/agent/internal/nodekey"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// ErrAlreadyJoined is returned when the config already describes a joined
// node and [Options.Force] is not set.
var ErrAlreadyJoined = errors.New("this host has already joined a control plane (use --force to re-join)")

// Options configures [Join].
type Options struct {
	// ControlPlaneURL is the http(s) origin of the control plane.
	ControlPlaneURL string
	// Token is the single-use join token from the dashboard.
	Token string
	// Name is the node's display name; empty uses the hostname.
	Name string
	// ConfigPath is where the resulting config is written.
	ConfigPath string
	// DataDir holds the credential, identity key and state files.
	DataDir string
	// Force allows replacing an existing joined config.
	Force bool
	// Insecure permits plaintext http:// and ws:// to non-loopback hosts.
	Insecure bool
	// Builder makes the node a builder; it is recorded in the config and
	// advertised in capabilities.builder.
	Builder bool
	// AgentVersion is reported to the control plane in the join request.
	AgentVersion string
	// Facts describes this host; it is sent in the join request.
	Facts facts.Static
	// HTTPClient is used for the join request; nil uses a client with a
	// 30-second timeout that does not follow redirects.
	HTTPClient *http.Client
	// Logger receives warnings such as clock skew; nil discards them.
	Logger *slog.Logger
}

// Join registers this host with the control plane and writes its config,
// credential and identity key. It returns the saved config.
func Join(ctx context.Context, opts Options) (config.Config, error) {
	base, err := config.ParseControlPlaneURL(opts.ControlPlaneURL, opts.Insecure)
	if err != nil {
		return config.Config{}, err
	}
	if opts.Token == "" {
		return config.Config{}, errors.New("a join token is required")
	}
	name := opts.Name
	if name == "" {
		name = opts.Facts.Hostname
	}
	if n := utf8.RuneCountInString(name); n < 1 || n > 63 {
		return config.Config{}, fmt.Errorf("node name %q must be 1-63 characters; pass --name", name)
	}

	previous, err := config.Load(opts.ConfigPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		previous = config.Config{}
	case err != nil && !opts.Force:
		return config.Config{}, fmt.Errorf("existing config is unreadable (use --force to replace it): %w", err)
	case err != nil:
		previous = config.Config{}
	case previous.Joined() && !opts.Force:
		return config.Config{}, fmt.Errorf("%w: %s (node %s)", ErrAlreadyJoined, opts.ConfigPath, previous.NodeID)
	}

	registration, err := newRegistrationID()
	if err != nil {
		return config.Config{}, err
	}
	cfg := config.Config{ControlPlaneURL: base.String(), Insecure: opts.Insecure, Builder: opts.Builder}.WithDataDir(opts.DataDir, registration)
	committed := false
	defer func() {
		if !committed {
			os.Remove(cfg.IdentityKeyFile)
			os.Remove(cfg.EncryptionKeyFile)
			os.Remove(cfg.CredentialFile)
		}
	}()

	// NOTE: the keys are persisted before the request so a successful join
	// can never leave the node without the private half of a key it
	// registered.
	pub, err := nodekey.CreateIdentity(cfg.IdentityKeyFile)
	if err != nil {
		return config.Config{}, fmt.Errorf("create identity key: %w", err)
	}
	enc, err := nodekey.CreateEncryptionKey(cfg.EncryptionKeyFile)
	if err != nil {
		return config.Config{}, fmt.Errorf("create encryption key: %w", err)
	}

	resp, err := postJoin(ctx, opts.httpClient(), opts.logger(), base, protocol.JoinRequest{
		Token:               opts.Token,
		Name:                name,
		Hostname:            opts.Facts.Hostname,
		AgentVersion:        opts.AgentVersion,
		OS:                  opts.Facts.OS,
		Arch:                opts.Facts.Arch,
		PublicKey:           base64.StdEncoding.EncodeToString(pub),
		EncryptionPublicKey: base64.StdEncoding.EncodeToString(enc.PublicKey().Bytes()),
		PublicIP:            opts.Facts.PublicIP,
		Hardware:            opts.Facts.Hardware,
		Capabilities:        capabilities(opts),
	})
	if err != nil {
		return config.Config{}, err
	}

	cfg.NodeID = resp.NodeID
	cfg.ConnectURL = resp.ConnectURL
	cfg.ControlPublicKey = resp.ControlPublicKey
	if err := cfg.Validate(); err != nil {
		return config.Config{}, fmt.Errorf("control plane returned an unusable join response: %w", err)
	}
	if err := config.WriteSecret(cfg.CredentialFile, []byte(resp.Credential+"\n")); err != nil {
		return config.Config{}, fmt.Errorf("write credential: %w", err)
	}

	// IMPORTANT: this atomic config write is the single commit point. Before
	// it, the old config still references the old registration's files,
	// which are untouched; after it, only the new ones are referenced.
	if err := config.Save(opts.ConfigPath, cfg); err != nil {
		return config.Config{}, fmt.Errorf("write config: %w", err)
	}
	committed = true

	// The new registration has its own, empty state file, so the previous
	// node's observed generation cannot make the agent ignore desired state.
	current := []string{cfg.IdentityKeyFile, cfg.EncryptionKeyFile, cfg.CredentialFile, cfg.StateFile}
	for _, old := range []string{previous.IdentityKeyFile, previous.EncryptionKeyFile, previous.CredentialFile, previous.StateFile} {
		if old == "" || slices.Contains(current, old) {
			continue
		}
		if err := os.Remove(old); err != nil && !errors.Is(err, fs.ErrNotExist) {
			opts.logger().Warn("could not remove file from the previous registration", "path", old, "err", err)
		}
	}
	return cfg, nil
}

// newRegistrationID returns a short random identifier that keeps each
// registration's secret files distinct on disk.
func newRegistrationID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (o Options) httpClient() *http.Client {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	return &http.Client{
		Timeout: 30 * time.Second,
		// SECURITY: a redirect could downgrade to http:// or move the token to
		// another host, bypassing the transport checks on the configured URL.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (o Options) logger() *slog.Logger {
	if o.Logger != nil {
		return o.Logger
	}
	return slog.New(slog.DiscardHandler)
}

func postJoin(ctx context.Context, client *http.Client, logger *slog.Logger, base *url.URL, body protocol.JoinRequest) (protocol.JoinResponse, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return protocol.JoinResponse{}, err
	}
	endpoint := base.JoinPath(protocol.JoinPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(data))
	if err != nil {
		return protocol.JoinResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	sent := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return protocol.JoinResponse{}, fmt.Errorf("join request to %s: %w", endpoint, err)
	}
	defer resp.Body.Close()
	if offset, ok := clock.OffsetFromResponse(resp, sent, time.Now()); ok && offset.Abs() > clock.WarnThreshold {
		logger.Warn("local clock differs from control plane; the agent corrects for it, but fix NTP on this host",
			"offset", offset.Round(time.Second).String())
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return protocol.JoinResponse{}, fmt.Errorf("read join response: %w", err)
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return protocol.JoinResponse{}, joinError(resp.StatusCode, payload)
	}

	var out protocol.JoinResponse
	if err := json.Unmarshal(payload, &out); err != nil {
		return protocol.JoinResponse{}, fmt.Errorf("decode join response: %w", err)
	}
	if out.Credential == "" {
		return protocol.JoinResponse{}, errors.New("join response is missing credential")
	}
	return out, nil
}

func joinError(status int, payload []byte) error {
	var e protocol.ErrorResponse
	if json.Unmarshal(payload, &e) != nil || (e.Error.Code == "" && e.Error.Message == "") {
		return fmt.Errorf("join rejected (HTTP %d)", status)
	}
	if e.Error.Code == "" {
		return fmt.Errorf("join rejected (HTTP %d): %s", status, e.Error.Message)
	}
	return fmt.Errorf("join rejected (HTTP %d, %s): %s", status, e.Error.Code, e.Error.Message)
}

// capabilities reports the host's capabilities with the operator's builder
// choice, which facts cannot detect.
func capabilities(opts Options) protocol.Capabilities {
	c := opts.Facts.Capabilities
	c.Builder = opts.Builder
	return c
}
