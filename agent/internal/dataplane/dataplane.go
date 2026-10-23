// Package dataplane routes the control plane's Phase 2 data frames (ADR
// 0004, ADR 0015) to the parts of the agent that act on them.
//
// Responsibilities:
//   - volume_delete goes to the volume manager, the only path that deletes
//     a volume's data;
//   - backup_job, backup_parts, restore_job, volume_copy_out and
//     volume_copy_in go to the backup runner, or are answered with a failed
//     result when the node has none;
//   - db_query: open the sealed credential with the node's key under the
//     node and request binding, find the workload's container on this node
//     and its bridge address, run the operation through a [DBQueryRunner]
//     with at most [MaxConcurrentQueries] at once, and answer
//     db_query_result.
//
// [Handler] implements conn.DataHandler.
package dataplane

import (
	"cmp"
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// MaxConcurrentQueries is how many db_query operations run at once on a
// node (ADR 0004, "Limits"); others wait for a slot until they time out.
const MaxConcurrentQueries = 4

// queryGrace is how long past its timeout_ms a query may take to answer,
// for dialing and encoding.
const queryGrace = 2 * time.Second

// sendTimeout bounds one result frame's send.
const sendTimeout = 10 * time.Second

// QueryTarget is the database a query runs against. Its fields match
// dbquery.Target, so one converts to the other.
type QueryTarget struct {
	// Engine is postgres, mysql, redis or mongodb.
	Engine string
	// Host is the container's address on its bridge network.
	Host string
	// Port is the engine's port in the container.
	Port int
	// Database is the default database from the container's environment
	// (POSTGRES_DB, MYSQL_DATABASE), "" for the engine's default.
	Database string
}

// QueryCredential is the principal a query connects as. Its fields match
// dbquery.Credential, so one converts to the other.
type QueryCredential struct {
	Username, Password string
	// ReadonlyPassword is the container's ROUNDHOUSE_RO_PASSWORD, set only
	// for provision_readonly, which creates roundhouse_ro with it.
	ReadonlyPassword string
}

// DBQueryRunner runs one data-browser operation. Run honours ctx, whose
// deadline is the query's timeout_ms plus a short grace, and always returns
// a result for q.RequestID: failures as OK false with a short error that
// never carries the credential.
type DBQueryRunner interface {
	Run(ctx context.Context, target QueryTarget, cred QueryCredential, q *protocol.DBQuery) *protocol.DBQueryResult
}

// Volumes deletes volumes; *volumes.Manager implements it.
type Volumes interface {
	Delete(ctx context.Context, volumeID string) error
}

// Backups runs backup, restore and copy tasks; the backup runner
// implements it. Each method must return quickly.
type Backups interface {
	StartBackup(m *protocol.BackupJob)
	AddParts(m *protocol.BackupParts)
	StartRestore(m *protocol.RestoreJob)
	StartCopyOut(m *protocol.VolumeCopyOut)
	StartCopyIn(m *protocol.VolumeCopyIn)
}

// Workloads finds a workload's container; *runtime.Runtime implements it.
type Workloads interface {
	Workload(id string) (runtime.WorkloadInfo, bool)
}

// Inspector reads a container's environment; *docker.Client implements it.
type Inspector interface {
	InspectContainer(ctx context.Context, id string) (docker.ContainerInfo, error)
}

// Options configures a [Handler].
type Options struct {
	NodeID string
	// Key is the node's X25519 key, which opens query credentials.
	Key *ecdh.PrivateKey
	// Volumes is nil on a node without volumes; deletes are then logged.
	Volumes Volumes
	// Backups is nil on a node that runs no backups; jobs are then answered
	// with a failed result.
	Backups   Backups
	Workloads Workloads
	Docker    Inspector
	// Query runs db_query operations; nil answers every query with an error.
	Query DBQueryRunner
	// Send delivers result frames.
	Send   func(ctx context.Context, m protocol.AgentMessage) error
	Logger *slog.Logger
}

// Handler implements conn.DataHandler. Create it with [New] and run it
// with [Handler.Run].
type Handler struct {
	opts   Options
	log    *slog.Logger
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	slots  chan struct{}
}

// New returns a handler. Frames it receives before [Handler.Run] are
// handled; Run only bounds their lifetime.
func New(opts Options) *Handler {
	ctx, cancel := context.WithCancel(context.Background())
	return &Handler{
		opts: opts, log: cmp.Or(opts.Logger, slog.New(slog.DiscardHandler)),
		ctx: ctx, cancel: cancel, slots: make(chan struct{}, MaxConcurrentQueries),
	}
}

// Run waits until ctx ends, then cancels what is in flight and waits for
// it.
func (h *Handler) Run(ctx context.Context) error {
	<-ctx.Done()
	h.cancel()
	h.wg.Wait()
	return nil
}

func (h *Handler) goTask(fn func()) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		fn()
	}()
}

func (h *Handler) send(m protocol.AgentMessage) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(h.ctx), sendTimeout)
	defer cancel()
	if err := h.opts.Send(ctx, m); err != nil {
		h.log.Warn("send data-plane result", "err", err)
	}
}

// DeleteVolume deletes a volume's data for a signed volume_delete.
func (h *Handler) DeleteVolume(m *protocol.VolumeDelete) {
	if h.opts.Volumes == nil {
		h.log.Warn("ignoring volume_delete: this node holds no volumes", "volume_id", m.VolumeID)
		return
	}
	h.goTask(func() {
		if err := h.opts.Volumes.Delete(h.ctx, m.VolumeID); err != nil {
			h.log.Error("volume delete refused", "volume_id", m.VolumeID, "err", err)
		}
	})
}

const noBackups = "backups are not supported on this node"

// StartBackup hands a backup_job to the backup runner.
func (h *Handler) StartBackup(m *protocol.BackupJob) {
	if h.opts.Backups == nil {
		h.goTask(func() { h.send(failedBackup(m.BackupID)) })
		return
	}
	h.opts.Backups.StartBackup(m)
}

// AddBackupParts hands more part URLs to a running backup.
func (h *Handler) AddBackupParts(m *protocol.BackupParts) {
	if h.opts.Backups != nil {
		h.opts.Backups.AddParts(m)
	}
}

// StartRestore hands a restore_job to the backup runner.
func (h *Handler) StartRestore(m *protocol.RestoreJob) {
	if h.opts.Backups == nil {
		h.goTask(func() { h.send(failedRestore(m.RestoreID)) })
		return
	}
	h.opts.Backups.StartRestore(m)
}

// StartCopyOut hands a volume_copy_out to the backup runner.
func (h *Handler) StartCopyOut(m *protocol.VolumeCopyOut) {
	if h.opts.Backups == nil {
		h.goTask(func() { h.send(failedBackup(m.BackupID)) })
		return
	}
	h.opts.Backups.StartCopyOut(m)
}

// StartCopyIn hands a volume_copy_in to the backup runner.
func (h *Handler) StartCopyIn(m *protocol.VolumeCopyIn) {
	if h.opts.Backups == nil {
		h.goTask(func() { h.send(failedRestore(m.MigrationID)) })
		return
	}
	h.opts.Backups.StartCopyIn(m)
}

func failedBackup(id string) *protocol.BackupResult {
	return &protocol.BackupResult{Type: protocol.TypeBackupResult, BackupID: id, Error: noBackups}
}

func failedRestore(id string) *protocol.RestoreResult {
	return &protocol.RestoreResult{Type: protocol.TypeRestoreResult, RestoreID: id, Error: noBackups}
}

// RunQuery runs a db_query and answers db_query_result.
func (h *Handler) RunQuery(m *protocol.DBQuery) {
	h.goTask(func() {
		start := time.Now()
		ctx, cancel := context.WithTimeout(h.ctx, time.Duration(m.TimeoutMS)*time.Millisecond+queryGrace)
		defer cancel()
		res := h.query(ctx, m)
		res.Type, res.RequestID = protocol.TypeDBQueryResult, m.RequestID
		if res.DurationMS <= 0 {
			res.DurationMS = time.Since(start).Milliseconds()
		}
		if err := res.Validate(); err != nil {
			res = queryError(m, "the result could not be sent: "+err.Error())
			res.DurationMS = time.Since(start).Milliseconds()
		}
		h.send(res)
	})
}

func queryError(m *protocol.DBQuery, msg string) *protocol.DBQueryResult {
	return &protocol.DBQueryResult{Type: protocol.TypeDBQueryResult, RequestID: m.RequestID, Error: msg}
}

func (h *Handler) query(ctx context.Context, m *protocol.DBQuery) *protocol.DBQueryResult {
	if h.opts.Query == nil {
		return queryError(m, "the data browser is not available on this node")
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	case <-ctx.Done():
		return queryError(m, fmt.Sprintf("too many queries are running on this node (at most %d at once)", MaxConcurrentQueries))
	}
	cred, err := protocol.OpenDBCredential(h.opts.Key, h.opts.NodeID, m)
	if err != nil {
		if errors.Is(err, protocol.ErrBoxWrongKey) {
			return queryError(m, "the credential is sealed to an encryption key this node does not hold")
		}
		return queryError(m, "cannot open the credential")
	}
	target, ro, err := h.target(ctx, m)
	if err != nil {
		return queryError(m, err.Error())
	}
	qc := QueryCredential{Username: cred.Username, Password: cred.Password}
	if m.Op.Type == protocol.DBOpProvisionReadonly {
		if ro == "" {
			return queryError(m, "the database container has no ROUNDHOUSE_RO_PASSWORD")
		}
		qc.ReadonlyPassword = ro
	}
	res := h.opts.Query.Run(ctx, target, qc, m)
	if res == nil {
		return queryError(m, "the query runner returned no result")
	}
	return res
}

// target finds the workload's container and the address to query it at,
// and returns its read-only password.
func (h *Handler) target(ctx context.Context, m *protocol.DBQuery) (QueryTarget, string, error) {
	if h.opts.Workloads == nil {
		return QueryTarget{}, "", errors.New("no workloads run on this node")
	}
	info, ok := h.opts.Workloads.Workload(m.WorkloadID)
	if !ok {
		return QueryTarget{}, "", fmt.Errorf("workload %s does not run on this node", m.WorkloadID)
	}
	if !info.Running || info.IP == "" {
		return QueryTarget{}, "", errors.New("the database is not running")
	}
	t := QueryTarget{Engine: string(m.Engine), Host: info.IP, Port: EnginePort(m.Engine, info.Spec.Ports)}
	var ro string
	if h.opts.Docker != nil {
		ci, err := h.opts.Docker.InspectContainer(ctx, info.ContainerID)
		if err != nil {
			return QueryTarget{}, "", errors.New("cannot inspect the database container")
		}
		env := envMap(ci.Config.Env)
		switch m.Engine {
		case protocol.EnginePostgres:
			t.Database = env["POSTGRES_DB"]
		case protocol.EngineMySQL:
			t.Database = env["MYSQL_DATABASE"]
		}
		ro = env["ROUNDHOUSE_RO_PASSWORD"]
	}
	return t, ro, nil
}

// enginePorts are the engines' default ports (ADR 0004, "Database
// templates").
var enginePorts = map[protocol.DatabaseEngine]int{
	protocol.EnginePostgres: 5432,
	protocol.EngineMySQL:    3306,
	protocol.EngineRedis:    6379,
	protocol.EngineMongoDB:  27017,
}

// EnginePort returns the port an engine listens on in a workload: its
// default port when the workload exposes it or exposes none, else the
// workload's only TCP port.
func EnginePort(engine protocol.DatabaseEngine, ports []protocol.WorkloadPort) int {
	def := enginePorts[engine]
	var tcp []int
	for _, p := range ports {
		if p.ContainerPort == def {
			return def
		}
		if p.Protocol == protocol.PortTCP {
			tcp = append(tcp, p.ContainerPort)
		}
	}
	if len(tcp) == 1 {
		return tcp[0]
	}
	return def
}

func envMap(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, e := range entries {
		if k, v, ok := strings.Cut(e, "="); ok {
			out[k] = v
		}
	}
	return out
}
