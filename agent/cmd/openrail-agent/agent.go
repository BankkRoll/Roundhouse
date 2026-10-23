package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/BankkRoll/Open-Rail/agent/internal/builder"
	"github.com/BankkRoll/Open-Rail/agent/internal/builds"
	"github.com/BankkRoll/Open-Rail/agent/internal/config"
	"github.com/BankkRoll/Open-Rail/agent/internal/conn"
	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	"github.com/BankkRoll/Open-Rail/agent/internal/ingress"
	"github.com/BankkRoll/Open-Rail/agent/internal/logship"
	agentruntime "github.com/BankkRoll/Open-Rail/agent/internal/runtime"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
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
}

func newAgent(cfg config.Config, client *conn.Client, log *slog.Logger) (*agent, error) {
	dataDir := cfg.RuntimeDir()
	dc, err := docker.FromEnv()
	if err != nil {
		return nil, err
	}
	a := &agent{log: log, client: client, docker: dc}
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
	})

	var b builder.Builder
	if cfg.Builder {
		// NOTE: the builder pushes to the registry system workload the
		// runtime runs at [protocol.RegistryListen]; until it is healthy a
		// build fails at push time with the registry error.
		b, err = builder.New(builder.Options{
			Logger:       log,
			DataDir:      dataDir,
			RegistryAddr: protocol.RegistryListen,
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

func (h handler) ApplyDesiredState(m *protocol.DesiredState) bool { return h.a.runtime.Apply(m) }

func (h handler) StartBuild(m *protocol.BuildJob) { h.a.builds.Start(m) }

func (h handler) CancelBuild(m *protocol.BuildCancel) { h.a.builds.Cancel(m.BuildID) }
