package main

import (
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/builder"
	"github.com/BankkRoll/Roundhouse/agent/internal/builds"
	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/conn"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/firewall"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/logship"
	agentruntime "github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// statusSendTimeout bounds one workload_status send; a status that cannot
// be sent is dropped, since hello carries every status after a reconnect.
const statusSendTimeout = 10 * time.Second

// agent wires the control connection to the workload runtime, ingress, log
// shipping and builds.
type agent struct {
	log     *slog.Logger
	client  *conn.Client
	docker  *docker.Client
	runtime *agentruntime.Runtime
	ingress *ingress.Manager
	logs    *logship.Shipper
	builds  *builds.Dispatcher
	// refusal is why workloads and builds are refused on this connection
	// ([conn.PlaintextRefusal]), "" when they run.
	refusal string
	// builder records whether this node runs builds.
	builder bool
	// firewall keeps containers away from the cloud metadata endpoint.
	firewall *firewall.Rules
}

// newAgent wires the agent's components. encryption is the node's X25519
// key, which opens sealed environments and build secrets.
func newAgent(cfg config.Config, client *conn.Client, encryption *ecdh.PrivateKey, log *slog.Logger) (*agent, error) {
	dataDir := cfg.RuntimeDir()
	refusal := conn.PlaintextRefusal(cfg.ConnectURL, os.Getenv(conn.DevEnv) == "1")
	if refusal != "" {
		log.Warn("connected over plaintext ws://: the node connects and reports, but " + refusal)
	}
	dc, err := docker.FromEnv()
	if err != nil {
		return nil, err
	}
	a := &agent{log: log, client: client, docker: dc, refusal: refusal, builder: cfg.Builder,
		firewall: firewall.New(nil, log.With("component", "firewall"))}
	a.ingress = ingress.New(ingress.Options{
		Logger:        log.With("component", "ingress"),
		UpstreamsPath: filepath.Join(dataDir, "ingress-upstreams.json"),
	})
	a.logs, err = logship.New(logship.Options{
		Docker: dc,
		Send:   func(ctx context.Context, l *protocol.Logs) error { return client.Send(ctx, l) },
		Dir:    filepath.Join(dataDir, "logs"),
		Logger: log.With("component", "logship"),
	})
	if err != nil {
		return nil, err
	}
	a.runtime = agentruntime.New(agentruntime.Options{
		Docker:     dc,
		Ingress:    a.ingress,
		DataDir:    dataDir,
		Logger:     log.With("component", "runtime"),
		Report:     a.reportStatus,
		Containers: a.followContainers,
		// SECURITY: two nodes can share one Docker engine; each manages
		// only its own containers.
		Namespace:       cfg.NodeID,
		AdoptUnlabelled: true,
		MinDrain:        ingress.SwitchDelay,
		OpenEnv: func(generation int64, w *protocol.WorkloadSpec) error {
			return protocol.OpenWorkloadEnv(encryption, cfg.NodeID, generation, w)
		},
		SecretsDir: secretsDir(dataDir),
		OnNetwork: func(ctx context.Context, n docker.Network) {
			if iface := n.BridgeInterface(); iface != "" {
				_ = a.firewall.Protect(ctx, iface)
			}
		},
		SystemLog: func(workloadID, deploymentID, text string) {
			line := protocol.Logs{
				Type:   protocol.TypeLogs,
				Source: protocol.LogSource{Type: protocol.LogSourceRuntime, WorkloadID: workloadID, DeploymentID: deploymentID},
				Lines:  []protocol.LogLine{{TS: time.Now().UnixMilli(), Stream: protocol.StreamSystem, Text: text}},
			}
			go func() { _ = a.logs.Submit(context.Background(), line) }()
		},
	})

	var b builder.Builder
	if cfg.Builder {
		// NOTE: the builder pushes to the registry system workload the
		// runtime runs at [protocol.RegistryListen]; until it is healthy a
		// build fails at push time with the registry error.
		b, err = builder.New(builder.Options{
			Logger:          log,
			DataDir:         dataDir,
			RegistryAddr:    protocol.RegistryListen,
			AppArmorProfile: os.Getenv("ROUNDHOUSE_BUILDKIT_APPARMOR_PROFILE"),
			EncryptionKey:   encryption,
			NodeID:          cfg.NodeID,
		})
		if err != nil {
			return nil, fmt.Errorf("builder: %w", err)
		}
	}
	a.builds = builds.New(builds.Options{
		Builder: b,
		Send:    func(ctx context.Context, r *protocol.BuildResult) error { return client.Send(ctx, r) },
		Logs:    a.logs.Submit,
		Ready: func() error {
			if refusal != "" {
				return errors.New(refusal)
			}
			if _, ok := a.runtime.RegistryAddr(); !ok {
				return errors.New("the local registry (sys_registry) is not running and healthy yet; retry shortly")
			}
			return nil
		},
		Logger: log.With("component", "builds"),
	})
	client.Handler = handler{a}
	client.OnConnect = func() {
		a.logs.Connected()
		a.builds.Connected()
	}
	return a, nil
}

// run serves until ctx ends. Every component stops before it returns;
// containers keep running.
func (a *agent) run(ctx context.Context) error {
	defer a.docker.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	var errMu sync.Mutex
	var errs []error
	goRun := func(name string, fn func(context.Context) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(ctx); err != nil {
				errMu.Lock()
				errs = append(errs, fmt.Errorf("%s: %w", name, err))
				errMu.Unlock()
				cancel()
			}
		}()
	}

	// The upstream DNS server goes first: Caddy resolves every route through
	// it, and serves the answers persisted before a restart right away.
	if pc, ln, err := ingress.ListenDNS(ingress.DefaultDNSListen); err != nil {
		return fmt.Errorf("upstream DNS on %s: %w", ingress.DefaultDNSListen, err)
	} else {
		goRun("dns", func(ctx context.Context) error { return a.ingress.ServeDNSOn(ctx, pc, ln) })
	}
	a.protectBridges(ctx)
	goRun("runtime", a.runtime.Run)
	goRun("ingress", a.ingress.Run)
	goRun("logs", a.logs.Run)
	goRun("builds", a.builds.Run)
	if ln, err := ingress.ListenAsk(ingress.DefaultAskListen); err != nil {
		// NOTE: only on-demand ACME certificates depend on this endpoint;
		// everything else keeps working without it.
		a.log.Error("cannot serve the TLS ask endpoint; on-demand certificates will be refused", "addr", ingress.DefaultAskListen, "err", err)
	} else {
		goRun("ask", func(ctx context.Context) error { return a.ingress.ServeAskOn(ctx, ln) })
	}
	goRun("conn", a.client.Run)

	wg.Wait()
	return errors.Join(errs...)
}

func (a *agent) reportStatus(ctx context.Context, rep protocol.WorkloadStatusReport) {
	ctx, cancel := context.WithTimeout(ctx, statusSendTimeout)
	defer cancel()
	err := a.client.Send(ctx, &protocol.WorkloadStatus{Type: protocol.TypeWorkloadStatus, WorkloadStatusReport: rep})
	if err != nil && !errors.Is(err, conn.ErrNotConnected) && ctx.Err() == nil {
		a.log.Warn("send workload status", "workload_id", rep.WorkloadID, "err", err)
	}
}

func (a *agent) followContainers(cs []agentruntime.Container) {
	targets := make([]logship.Target, len(cs))
	for i, c := range cs {
		targets[i] = logship.Target{
			ContainerID: c.ID, WorkloadID: c.WorkloadID, DeploymentID: c.DeploymentID,
			Running: c.Running, StartedAt: c.StartedAt,
		}
	}
	a.logs.Sync(targets)
}

// handler routes verified control messages to the runtime and builds.
type handler struct{ a *agent }

func (h handler) HasDesiredState() bool { return h.a.runtime.HasDesiredState() }

func (h handler) ApplyDesiredState(m *protocol.DesiredState) bool {
	if h.a.refusal != "" && (len(m.Workloads) > 0 || m.Registry != nil) {
		h.a.log.Error("not applying desired state", "generation", m.Generation, "reason", h.a.refusal)
		go h.a.reportRefused(m.Workloads)
		return false
	}
	return h.a.runtime.Apply(m)
}

// reportRefused reports each workload of a refused desired state as pending
// with the reason, so the dashboard says why nothing starts. The runtime
// never sees them, so nothing else reports them.
func (a *agent) reportRefused(ws []protocol.WorkloadSpec) {
	now := time.Now().UnixMilli()
	for _, w := range ws {
		a.reportStatus(context.Background(), protocol.WorkloadStatusReport{
			WorkloadID: w.ID, DeploymentID: w.DeploymentID, State: protocol.StatePending,
			Message: a.refusal, TS: now,
		})
	}
}

// secretsDir is where the runtime writes mount_as_file values: the host
// tmpfs on Linux; elsewhere (local development only) the data directory.
func secretsDir(dataDir string) string {
	if goruntime.GOOS == "linux" {
		return agentruntime.DefaultSecretsDir
	}
	return filepath.Join(dataDir, "secrets")
}

func (h handler) StartBuild(m *protocol.BuildJob) { h.a.builds.Start(m) }

func (h handler) CancelBuild(m *protocol.BuildCancel) { h.a.builds.Cancel(m.BuildID) }

// protectBridges installs the metadata firewall rules for the bridges that
// exist already, before the runtime starts any container: the build
// network's and every managed network's. Networks the runtime creates later
// get theirs through its OnNetwork hook. Failures only warn: a host where
// the rules can't be installed still runs workloads.
func (a *agent) protectBridges(ctx context.Context) {
	if a.builder {
		_ = a.firewall.Protect(ctx, builder.BridgeInterface)
	}
	nets, err := a.docker.ListNetworks(ctx, agentruntime.ManagedFilter)
	if err != nil {
		a.log.Warn("list networks for the metadata firewall", "err", err)
		return
	}
	for _, n := range nets {
		if iface := n.BridgeInterface(); iface != "" {
			_ = a.firewall.Protect(ctx, iface)
		}
	}
}
