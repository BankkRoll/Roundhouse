// Command roundhouse-agent runs on every Roundhouse node. It joins the node to a
// control plane once, then keeps a signed, authenticated WebSocket session
// open to receive desired state and report health.
//
// Usage:
//
//	roundhouse-agent join --url <control-plane> (--token <token> | --token-file <path>) [--name <name>] [--config <path>] [--builder] [--force] [--insecure]
//	roundhouse-agent run [--config <path>]
//	roundhouse-agent version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/conn"
	"github.com/BankkRoll/Roundhouse/agent/internal/enroll"
	"github.com/BankkRoll/Roundhouse/agent/internal/facts"
	"github.com/BankkRoll/Roundhouse/agent/internal/state"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// version is set at build time with -ldflags "-X main.version=<v>".
var version = "dev"

const usage = `Usage: roundhouse-agent <command> [flags]

Commands:
  join      Register this host with a control plane
  run       Connect to the control plane and serve
  version   Print the agent version

Run "roundhouse-agent <command> -h" for command flags.
`

func main() {
	logger := newLogger(os.Stderr)
	if err := run(os.Args[1:], logger, os.Stdout, os.Stderr); err != nil {
		logger.Error(err.Error())
		os.Exit(1)
	}
}

// newLogger logs JSON for journald and log shippers, and readable text when
// a person is watching the terminal.
func newLogger(stderr *os.File) *slog.Logger {
	if fi, err := stderr.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
		return slog.New(slog.NewTextHandler(stderr, nil))
	}
	return slog.New(slog.NewJSONHandler(stderr, nil))
}

// run executes one command. Help requested with -h is not an error.
func run(args []string, logger *slog.Logger, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return errors.New("missing command")
	}
	err := dispatch(args, logger, stdout, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return err
}

func dispatch(args []string, logger *slog.Logger, stdout, stderr io.Writer) error {
	switch cmd, rest := args[0], args[1:]; cmd {
	case "join":
		return cmdJoin(rest, logger, stderr)
	case "run":
		return cmdRun(rest, logger, stderr)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, version)
		return nil
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return nil
	default:
		fmt.Fprint(stderr, usage)
		return fmt.Errorf("unknown command %q", cmd)
	}
}

func cmdJoin(args []string, logger *slog.Logger, stderr io.Writer) error {
	fset := flag.NewFlagSet("join", flag.ContinueOnError)
	fset.SetOutput(stderr)
	cpURL := fset.String("url", "", "control plane URL, e.g. https://roundhouse.example.com")
	token := fset.String("token", "", "single-use join token; visible in the process list, prefer --token-file")
	tokenFile := fset.String("token-file", "", "read the join token from this file (alternatively set ROUNDHOUSE_JOIN_TOKEN)")
	name := fset.String("name", "", "node display name (default: hostname)")
	cfgPath := fset.String("config", config.DefaultPath(), "config file to write")
	dataDir := fset.String("data-dir", "", "directory for credential, identity key and state (default: /var/lib/roundhouse on Linux, next to --config elsewhere)")
	force := fset.Bool("force", false, "replace an existing joined config")
	insecure := fset.Bool("insecure", false, "allow plaintext http:// and ws:// to a non-loopback control plane (testing only)")
	builderNode := fset.Bool("builder", false, "make this node a builder: run the local image registry and accept build jobs")
	if err := fset.Parse(args); err != nil {
		return err
	}
	if err := resolveToken(token, *tokenFile); err != nil {
		return err
	}
	if *cpURL == "" || *token == "" {
		fset.Usage()
		return errors.New("join requires --url and a token (--token, --token-file or ROUNDHOUSE_JOIN_TOKEN)")
	}
	if *dataDir == "" {
		*dataDir = config.DefaultDataDir(*cfgPath)
	}
	if *insecure {
		warnInsecure(logger)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	f, err := facts.Collect(ctx)
	if err != nil {
		return err
	}
	cfg, err := enroll.Join(ctx, enroll.Options{
		ControlPlaneURL: *cpURL,
		Token:           *token,
		Name:            *name,
		ConfigPath:      *cfgPath,
		DataDir:         *dataDir,
		Force:           *force,
		Insecure:        *insecure,
		Builder:         *builderNode,
		Logger:          logger,
		AgentVersion:    version,
		Facts:           f,
	})
	if err != nil {
		return err
	}
	logger.Info("joined control plane", "node_id", cfg.NodeID, "config", *cfgPath)
	return nil
}

func cmdRun(args []string, logger *slog.Logger, stderr io.Writer) error {
	fset := flag.NewFlagSet("run", flag.ContinueOnError)
	fset.SetOutput(stderr)
	cfgPath := fset.String("config", config.DefaultPath(), "config file")
	if err := fset.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(*cfgPath)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("no config at %s: run `roundhouse-agent join` first", *cfgPath)
	}
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid config %s: %w", *cfgPath, err)
	}
	credential, err := config.ReadSecret(cfg.CredentialFile)
	if err != nil {
		return fmt.Errorf("read credential: %w", err)
	}
	// NOTE: the identity key is not used yet; it is reserved for node-to-node
	// WireGuard and mutual authentication in a later phase. Requiring it now
	// catches a half-restored data directory early.
	if _, err := os.Stat(cfg.IdentityKeyFile); err != nil {
		return fmt.Errorf("identity key: %w", err)
	}
	controlKey, err := protocol.ParsePublicKey(cfg.ControlPublicKey)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	f, err := facts.Collect(ctx)
	if err != nil {
		return err
	}
	f.Capabilities.Builder = cfg.Builder
	sampler := facts.NewSampler(ctx)
	logger = logger.With("node_id", cfg.NodeID)
	logger.Info("starting agent", "version", version, "os", f.OS, "arch", f.Arch,
		"docker", f.DockerVersion != nil, "builder", cfg.Builder)
	if cfg.Insecure {
		warnInsecure(logger)
	}

	client := &conn.Client{
		ConnectURL:   cfg.ConnectURL,
		Credential:   credential,
		NodeID:       cfg.NodeID,
		ControlKey:   controlKey,
		ControlKeyID: cfg.ControlKeyID,
		OnControlKeyID: func(kid string) error {
			return pinKeyID(*cfgPath, kid)
		},
		Usage:  sampler.Sample,
		State:  state.NewStore(cfg.StateFile),
		Logger: logger,
	}
	a, err := newAgent(cfg, client, logger)
	if err != nil {
		return err
	}
	client.Hello = func(ctx context.Context, observed int64) protocol.Hello {
		h := f.Hello(ctx, cfg.NodeID, version, observed)
		h.Statuses = a.runtime.Statuses()
		return h
	}
	start := time.Now()
	if err := a.run(ctx); err != nil {
		return err
	}
	logger.Info("agent stopped", "uptime", time.Since(start).Round(time.Second).String())
	return nil
}

// resolveToken fills token from tokenFile or ROUNDHOUSE_JOIN_TOKEN when it was
// not given on the command line.
//
// SECURITY: --token stays visible in the process list to every local user
// while join runs. A file or the environment (readable only by the same user
// and root) avoids that exposure.
func resolveToken(token *string, tokenFile string) error {
	if *token != "" && tokenFile != "" {
		return errors.New("pass only one of --token and --token-file")
	}
	if tokenFile != "" {
		t, err := config.ReadSecret(tokenFile)
		if err != nil {
			return fmt.Errorf("read --token-file: %w", err)
		}
		*token = t
	}
	if *token == "" {
		*token = os.Getenv("ROUNDHOUSE_JOIN_TOKEN")
	}
	return nil
}

func warnInsecure(logger *slog.Logger) {
	logger.Warn("INSECURE MODE: plaintext http:// and ws:// are allowed to a non-loopback control plane; " +
		"the join token, node credential and control traffic can be read and tampered with in transit. Never use this in production.")
}

// pinKeyID records the control plane's key id in the config so later
// envelopes signed under any other kid are rejected.
func pinKeyID(cfgPath, kid string) error {
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	cfg.ControlKeyID = kid
	return config.Save(cfgPath, cfg)
}
