package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/atomicfile"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// VolumeSource resolves workload mounts; *volumes.Manager implements it.
type VolumeSource interface {
	// VolumeReady reports whether a volume can be mounted, and why not.
	VolumeReady(volumeID string) (bool, string)
	// MountSource returns the host directory to bind for a volume, first
	// giving a fresh data directory to imageUser ("uid[:gid]") when the
	// volume names no owner.
	MountSource(volumeID, imageUser string) (string, error)
}

// ExecRunner runs a process inside a container; *docker.Client implements
// it.
type ExecRunner interface {
	RunExec(ctx context.Context, containerID string, run docker.ExecRun) (int, error)
}

// admitData checks a service workload's Phase 2 fields (ADR 0004) against
// its desired state's volumes and returns why it may not run ("" when it
// may). It repeats the protocol's validation, so a gap there can't bind one
// service's volume into another.
func (r *Runtime) admitData(w *protocol.WorkloadSpec, volumes map[string]*protocol.VolumeSpec) string {
	// SECURITY: ADR 0004 publishes a port only behind a final drop of every
	// source outside publish_allowed_cidrs. A node that cannot install that
	// allowlist refuses rather than publish a database to the whole
	// internet; one that can still waits for it on every create and start
	// ([Runtime.publishWait]).
	if publishes(w) && r.opts.Publish == nil {
		return noPublishReason(w)
	}
	if w.Healthcheck != nil && w.Healthcheck.Type == protocol.HealthcheckExec && r.opts.Exec == nil {
		return "refusing an exec health check: this node cannot run commands in containers"
	}
	if len(w.Mounts) == 0 {
		return ""
	}
	if r.opts.Volumes == nil {
		return "refusing volume mounts: this node does not hold volumes"
	}
	if len(w.Mounts) > protocol.MaxMountsPerWorkload {
		return fmt.Sprintf("refusing %d mounts: at most %d per workload", len(w.Mounts), protocol.MaxMountsPerWorkload)
	}
	for _, m := range w.Mounts {
		if !protocol.IsSafeMountPath(m.Path) {
			return fmt.Sprintf("refusing mount path %q", m.Path)
		}
		v := volumes[m.VolumeID]
		if v == nil {
			return fmt.Sprintf("refusing mount of volume %s: the desired state does not list it", m.VolumeID)
		}
		// SECURITY: a volume is bound only into its own service.
		if v.ProjectID != *w.ProjectID || v.EnvironmentID != *w.EnvironmentID || v.ServiceID != *w.ServiceID {
			return fmt.Sprintf("refusing mount of volume %s: it belongs to another service", m.VolumeID)
		}
	}
	return ""
}

// -----------------------------------------------------------------------------
// Mount exclusivity and stop_first
// -----------------------------------------------------------------------------

// predecessorWait returns why s may not be created yet, "" when it may. It
// enforces ADR 0004's invariant that at most one container mounts a volume:
// before s is created, every container that holds one of its volumes, and
// for stop_first every container of its service and environment, must be
// gone. Obsolete ones are stopped (SIGTERM, their stop grace, SIGKILL) and
// removed here; a container another desired workload runs is never touched.
// Caller holds r.mu.
func (r *Runtime) predecessorWait(s *wantSpec, wanted map[string]*wantSpec) string {
	if !s.stopFirst {
		return ""
	}
	vols := mountedVolumes(&s.WorkloadSpec)
	for _, inst := range r.sortedInstances() {
		shared := sharedVolume(inst.meta.volumes, vols)
		sameService := s.ServiceID != nil && s.EnvironmentID != nil &&
			inst.meta.serviceID == *s.ServiceID && inst.meta.environmentID == *s.EnvironmentID
		if shared == "" && !sameService && inst.meta.workloadID != s.ID {
			continue
		}
		if other := wanted[inst.meta.workloadID]; other != nil && other != s && other.SpecHash == inst.meta.specHash {
			if shared == "" {
				// A sibling replica without a shared volume runs side by side.
				continue
			}
			return fmt.Sprintf("waiting for volume %s: workload %s mounts it", shared, inst.meta.workloadID)
		}
		if !inst.busy {
			r.removeAsync(inst, "stop first")
		}
		return fmt.Sprintf("waiting for container %s to stop before starting (stop first)", short(inst.id))
	}
	for id, ws := range r.workloads {
		if id != s.ID && ws.busy {
			if v := sharedVolume(ws.volumes, vols); v != "" {
				return fmt.Sprintf("waiting for volume %s: workload %s is starting with it", v, id)
			}
		}
	}
	for _, v := range vols {
		if ok, why := r.opts.Volumes.VolumeReady(v); !ok {
			return "waiting for volume: " + why
		}
	}
	return ""
}

func sharedVolume(a, b []string) string {
	for _, v := range a {
		if slices.Contains(b, v) {
			return v
		}
	}
	return ""
}

// resolveMounts binds s's volumes, giving a fresh data directory to the
// image's user.
func (r *Runtime) resolveMounts(ctx context.Context, s *wantSpec) error {
	if len(s.Mounts) == 0 {
		return nil
	}
	user := ""
	if img, err := r.d.InspectImage(ctx, s.Image); err == nil && img.Config != nil {
		user = img.Config.User
	}
	mounts := make([]docker.Mount, 0, len(s.Mounts))
	for _, m := range s.Mounts {
		src, err := r.opts.Volumes.MountSource(m.VolumeID, user)
		if err != nil {
			return err
		}
		mounts = append(mounts, docker.Mount{Type: docker.MountBind, Source: src, Target: m.Path, ReadOnly: m.ReadOnly})
	}
	s.mounts = mounts
	return nil
}

// VolumeInUse reports whether any managed container mounts the volume, or
// is being created with it.
func (r *Runtime) VolumeInUse(volumeID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, inst := range r.instances {
		if slices.Contains(inst.meta.volumes, volumeID) {
			return true
		}
	}
	for _, ws := range r.workloads {
		if ws.busy && slices.Contains(ws.volumes, volumeID) {
			return true
		}
	}
	return false
}

// -----------------------------------------------------------------------------
// Holds
// -----------------------------------------------------------------------------

// hold keeps a workload's containers, or a volume's, stopped for a backup,
// restore or copy.
type hold struct {
	workloadID, volumeID, reason string
}

func (h *hold) covers(workloadID string, volumes []string) bool {
	return (h.workloadID != "" && h.workloadID == workloadID) ||
		(h.volumeID != "" && slices.Contains(volumes, h.volumeID))
}

// heldReason returns why a workload with these volumes must stay stopped,
// "" when it need not. Caller holds r.mu.
func (r *Runtime) heldReason(workloadID string, volumes []string) string {
	for h := range r.holds {
		if h.covers(workloadID, volumes) {
			return h.reason
		}
	}
	return ""
}

// Hold stops every container of workloadID and every container that mounts
// volumeID (either may be empty), keeps them and any replacement from
// starting, and returns once none of them runs. Calling release lets them
// start again; containers the hold stopped are started at once. When ctx
// ends first, the hold is released and ctx's error returned.
func (r *Runtime) Hold(ctx context.Context, workloadID, volumeID, reason string) (release func(), err error) {
	h := &hold{workloadID: workloadID, volumeID: volumeID, reason: reason}
	r.mu.Lock()
	if r.holds == nil {
		r.holds = map[*hold]bool{}
	}
	r.holds[h] = true
	since := r.listSeq
	r.mu.Unlock()
	release = sync.OnceFunc(func() {
		r.mu.Lock()
		delete(r.holds, h)
		r.mu.Unlock()
		r.poke()
	})
	r.poke()
	for !r.holdSettled(h, since) {
		t := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Stop()
			release()
			return nil, ctx.Err()
		case <-t.C:
		}
	}
	return release, nil
}

// holdSettled reports whether a pass has run since the hold was placed and
// every container it covers is observed stopped.
func (r *Runtime) holdSettled(h *hold, since uint64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.passSeq <= since {
		return false
	}
	for _, inst := range r.instances {
		if h.covers(inst.meta.workloadID, inst.meta.volumes) && (inst.running || inst.busy || !inst.settled()) {
			return false
		}
	}
	for id, ws := range r.workloads {
		if ws.busy && h.covers(id, ws.volumes) {
			return false
		}
	}
	return true
}

// stopAsync stops a container without removing it, for a hold. Caller
// holds r.mu.
func (r *Runtime) stopAsync(inst *instance) {
	inst.busy = true
	inst.heldStop = true
	r.stopProbe(inst)
	r.goTask(func() {
		err := r.d.StopContainer(r.ctx, inst.id, inst.meta.stopGrace())
		r.mu.Lock()
		inst.busy = false
		inst.doneSeq = r.listSeq
		if err == nil {
			r.setHeldStop(inst.id, true)
		}
		r.mu.Unlock()
		if err != nil && r.ctx.Err() == nil {
			r.log.Warn("stop container failed", "workload_id", inst.meta.workloadID, "container", short(inst.id), "err", err)
		} else {
			r.log.Info("stopped container", "workload_id", inst.meta.workloadID, "container", short(inst.id))
		}
		r.poke()
	})
}

// -----------------------------------------------------------------------------
// Workload lookup
// -----------------------------------------------------------------------------

// WorkloadInfo describes a desired workload and its current container.
type WorkloadInfo struct {
	Spec protocol.WorkloadSpec
	// ContainerID is "" when the workload has no container of its spec.
	ContainerID string
	Running     bool
	Healthy     bool
	// IP is the container's address on its network, "" when not running.
	IP string
}

// Workload returns a desired service workload and its current container.
// The spec's Env and SecretFiles are cleared.
func (r *Runtime) Workload(id string) (WorkloadInfo, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.desired == nil {
		return WorkloadInfo{}, false
	}
	for i := range r.desired.Workloads {
		w := r.desired.Workloads[i]
		if w.ID != id {
			continue
		}
		w.Env, w.SecretFiles = nil, nil
		info := WorkloadInfo{Spec: w}
		if cur := r.current(&wantSpec{WorkloadSpec: w}); cur != nil {
			info.ContainerID = cur.id
			info.Running = cur.running
			info.Healthy = cur.running && cur.health == healthHealthy
			if cur.running {
				info.IP = cur.ips[w.Network]
			}
		}
		return info, true
	}
	return WorkloadInfo{}, false
}

// WorkloadStatus returns the status last reported for a workload.
func (r *Runtime) WorkloadStatus(id string) (protocol.WorkloadStatusReport, bool) {
	return r.statuses.get(id)
}

// Poke asks for a reconcile pass soon.
func (r *Runtime) Poke() { r.poke() }

// -----------------------------------------------------------------------------
// Exec probes
// -----------------------------------------------------------------------------

// execProbeOutput bounds the output an exec probe keeps for its message.
const execProbeOutput = 512

// execProbe runs an exec health check inside a container: exit code 0
// passes. When ctx ends first the process is killed.
func (r *Runtime) execProbe(ctx context.Context, containerID string, cmd []string) error {
	if r.opts.Exec == nil {
		return errors.New("exec probes are not supported on this node")
	}
	out := &tailBuffer{max: execProbeOutput}
	code, err := r.opts.Exec.RunExec(ctx, containerID, docker.ExecRun{Cmd: cmd, Stdout: out, Stderr: out})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%s timed out", cmd[0])
		}
		return fmt.Errorf("%s: %w", cmd[0], err)
	}
	if code != 0 {
		msg := strings.TrimSpace(out.String())
		if msg != "" {
			return fmt.Errorf("%s exited with code %d: %s", cmd[0], code, msg)
		}
		return fmt.Errorf("%s exited with code %d", cmd[0], code)
	}
	return nil
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if over := t.buf.Len() - t.max; over > 0 {
		t.buf.Next(over)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(t.buf.String(), "")
}

// Container returns the ID of a desired workload's current container and
// whether it runs; ok is false when the workload has no container.
func (r *Runtime) Container(workloadID string) (id string, running, ok bool) {
	info, found := r.Workload(workloadID)
	if !found || info.ContainerID == "" {
		return "", false, false
	}
	return info.ContainerID, info.Running, true
}

// WaitHealthy waits until a desired workload's current container runs and
// passes its probe, or ctx ends.
func (r *Runtime) WaitHealthy(ctx context.Context, workloadID string) error {
	for {
		info, ok := r.Workload(workloadID)
		if ok && info.Healthy {
			return nil
		}
		t := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Stop()
			if !ok {
				return fmt.Errorf("workload %s is not desired on this node", workloadID)
			}
			st, _ := r.WorkloadStatus(workloadID)
			if st.Message != "" {
				return fmt.Errorf("workload %s did not become healthy (%s: %s)", workloadID, st.State, st.Message)
			}
			return fmt.Errorf("workload %s did not become healthy (%s)", workloadID, st.State)
		case <-t.C:
		}
	}
}

// heldStopsFile records the containers a hold stopped, so an agent that
// restarts mid-hold still starts them again: a database that exits 0 on
// SIGTERM would otherwise stay down under an on_failure policy.
const heldStopsFile = "held-stops.json"

func (r *Runtime) heldStopsPath() string {
	if r.opts.DataDir == "" {
		return ""
	}
	return filepath.Join(r.opts.DataDir, heldStopsFile)
}

// setHeldStop records or clears a container stopped by a hold. Caller holds
// r.mu.
func (r *Runtime) setHeldStop(id string, on bool) {
	if r.heldStops[id] == on {
		return
	}
	if on {
		r.heldStops[id] = true
	} else {
		delete(r.heldStops, id)
	}
	path := r.heldStopsPath()
	if path == "" {
		return
	}
	data, _ := json.Marshal(slices.Sorted(maps.Keys(r.heldStops)))
	if err := atomicfile.Write(path, data, 0o600); err != nil {
		r.log.Warn("persist held containers", "path", path, "err", err)
	}
}
