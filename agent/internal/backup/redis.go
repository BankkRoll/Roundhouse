package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/rhbk"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// redisLoadTimeout bounds the one-off server that turns the restored RDB
// into an append-only file.
const redisLoadTimeout = 30 * time.Minute

// restoreRedis follows ADR 0004's Redis procedure. A running server would
// overwrite dump.rdb on shutdown, and an AOF-enabled server ignores the RDB
// at start, so:
//  1. stop the workload and write dump.rdb into its data directory, removing
//     any append-only files;
//  2. start a one-off server of the same image on that directory, with no
//     network and appendonly off, so it loads the RDB;
//  3. CONFIG SET appendonly yes, which rewrites the AOF from the loaded
//     data, wait for the rewrite, and shut the one-off server down;
//  4. start the workload, which loads the fresh AOF.
func (r *Runner) restoreRedis(ctx context.Context, t restoreTask, dataPath string, rr *rhbk.Reader) (int64, error) {
	h, err := rr.Next()
	if err != nil {
		return 0, fmt.Errorf("read backup: %w", err)
	}
	if h.Format != rhbk.FormatRDB || h.Engine != string(protocol.EngineRedis) {
		return 0, fmt.Errorf("backup entry %s is not a Redis RDB", h.Name)
	}
	id, _, ok := r.opts.Workloads.Container(t.source.WorkloadID)
	if !ok {
		return 0, fmt.Errorf("workload %s has no container on this node", t.source.WorkloadID)
	}
	info, err := r.opts.Docker.InspectContainer(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("inspect workload %s: %w", t.source.WorkloadID, err)
	}
	mountPath := "/data"
	for _, m := range info.Mounts {
		if filepath.Clean(m.Source) == filepath.Clean(dataPath) {
			mountPath = m.Destination
		}
	}

	release, err := r.opts.Workloads.Hold(ctx, t.source.WorkloadID, "stopped for a restore")
	if err != nil {
		return 0, fmt.Errorf("stop workload %s: %w", t.source.WorkloadID, err)
	}
	defer release()

	r.system(t.id, "writing dump.rdb")
	tmp := filepath.Join(dataPath, ".dump.rdb.restore")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, rr)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		if _, nerr := rr.Next(); !errors.Is(nerr, io.EOF) {
			err = errors.New("a Redis backup holds exactly one entry")
		}
	}
	if err != nil {
		os.Remove(tmp)
		return 0, err
	}
	for _, aof := range []string{"appendonlydir", "appendonly.aof"} {
		if err := os.RemoveAll(filepath.Join(dataPath, aof)); err != nil {
			return 0, err
		}
	}
	if err := os.Rename(tmp, filepath.Join(dataPath, "dump.rdb")); err != nil {
		return 0, err
	}
	lctx, cancel := context.WithTimeout(ctx, redisLoadTimeout)
	defer cancel()
	if err := r.rewriteAOF(lctx, t.id, info, dataPath, mountPath); err != nil {
		return 0, fmt.Errorf("load the RDB: %w", err)
	}
	return n, nil
}

// rewriteAOF runs the one-off server of steps 2 and 3.
func (r *Runner) rewriteAOF(ctx context.Context, taskID string, workload docker.ContainerInfo, dataPath, mountPath string) error {
	server := "redis-server"
	if strings.Contains(workload.Config.Image, "valkey") {
		server = "valkey-server"
	}
	name := "roundhouse-task-" + taskID
	_ = r.opts.Docker.RemoveContainer(ctx, name)
	grace := 30
	id, err := r.opts.Docker.CreateContainer(ctx, name, docker.ContainerCreate{
		Image:  workload.Image,
		Cmd:    []string{server, "--appendonly", "no", "--dir", mountPath, "--save", ""},
		Labels: map[string]string{"roundhouse.task_id": taskID},
		// The image's entrypoint fixes ownership and drops to its user.
		StopTimeout: &grace,
		HostConfig: docker.HostConfig{
			NetworkMode:   "none",
			RestartPolicy: docker.RestartPolicy{Name: "no"},
			SecurityOpt:   []string{"no-new-privileges:true"},
			CapDrop:       []string{"ALL"},
			CapAdd:        []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"},
			Mounts:        []docker.Mount{{Type: docker.MountBind, Source: dataPath, Target: mountPath}},
			LogConfig:     docker.LogConfig{Type: "json-file"},
		},
	})
	if err != nil {
		return err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		_ = r.opts.Docker.RemoveContainer(rctx, id)
		cancel()
	}()
	if err := r.opts.Docker.StartContainer(ctx, id); err != nil {
		return err
	}
	t := &engineTarget{d: r.opts.Docker, container: id, env: map[string]string{}, log: r.taskLog(taskID)}
	cli := `cli=$(command -v valkey-cli || command -v redis-cli) || exit 127; `
	waitFor := func(what, script string, done func(string) bool) error {
		for {
			out, err := t.output(ctx, cli+script, nil, nil)
			if err == nil && done(out) {
				return nil
			}
			if !sleepCtx(ctx, 500*time.Millisecond) {
				return fmt.Errorf("timed out waiting for %s", what)
			}
		}
	}
	if err := waitFor("the server to load the RDB", `exec "$cli" ping`, func(s string) bool {
		return strings.TrimSpace(s) == "PONG"
	}); err != nil {
		return err
	}
	if _, err := t.output(ctx, cli+`exec "$cli" CONFIG SET appendonly yes`, nil, nil); err != nil {
		return err
	}
	if err := waitFor("the AOF rewrite", `exec "$cli" INFO persistence`, func(s string) bool {
		return strings.Contains(s, "aof_enabled:1") && strings.Contains(s, "aof_rewrite_in_progress:0") &&
			strings.Contains(s, "aof_rewrite_scheduled:0") && strings.Contains(s, "aof_last_bgrewrite_status:ok")
	}); err != nil {
		return err
	}
	// NOTE: SHUTDOWN closes the connection without a reply, so its exit
	// status means nothing; stopping the container confirms the exit.
	_, _ = t.output(ctx, cli+`exec "$cli" SHUTDOWN`, nil, nil)
	return r.opts.Docker.StopContainer(ctx, id, time.Duration(grace)*time.Second)
}
