//go:build integration

package runtime_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	"github.com/BankkRoll/Roundhouse/agent/internal/volumes"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// postgresImage is the template's Postgres 17, pinned as in
// packages/shared/src/database-images.json.
const postgresImage = "postgres:17-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27"

// itVolumesRoot is a directory on the Docker daemon's host that
// agent/test/integration.sh mounts into the test container at the same
// path, so the volumes the test creates are bind sources the engine sees.
const itVolumesRoot = "/var/lib/roundhouse-it"

func volumesRoot(t *testing.T) string {
	t.Helper()
	if _, err := os.Stat(itVolumesRoot); err != nil {
		t.Skipf("%s is not mounted from the daemon's host (run agent/test/integration.sh): %v", itVolumesRoot, err)
	}
	root := filepath.Join(itVolumesRoot, dockertest.Unique("vols-"))
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

// psql runs a statement in a Postgres container and returns its output.
func psql(t *testing.T, c *docker.Client, id, sql string) string {
	t.Helper()
	var out, errOut bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	code, err := c.RunExec(ctx, id, docker.ExecRun{
		Cmd: []string{"psql", "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql}, Stdout: &out, Stderr: &errOut,
	})
	if err != nil || code != 0 {
		t.Fatalf("psql %q: code %d, %v: %s", sql, code, err, errOut.String())
	}
	return strings.TrimSpace(out.String())
}

func TestDatabaseOnAVolumeWithExecProbeStopFirstAndHold(t *testing.T) {
	root := volumesRoot(t)
	var rt atomic.Pointer[runtime.Runtime]
	vm, err := volumes.New(volumes.Options{
		Root: root, Quota: volumes.QuotaNone, StatePath: filepath.Join(root, "volumes.json"),
		OnChange: func() {
			if r := rt.Load(); r != nil {
				r.Poke()
			}
		},
		InUse: func(id string) bool { return rt.Load().VolumeInUse(id) },
	})
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(o *runtime.Options) {
		o.Volumes = vm
		o.Exec = o.Docker.(*docker.Client)
	})
	rt.Store(h.rt)
	ctx, cancel := context.WithCancel(context.Background())
	vm.Start(ctx)
	done := make(chan struct{})
	go func() { defer close(done); _ = vm.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	dockertest.Pull(t, h.c, postgresImage)

	vol := protocol.VolumeSpec{ID: "vol_" + h.ns, SizeMB: 512, ProjectID: h.project, EnvironmentID: h.env, ServiceID: "svc_" + h.ns}
	h.volumes = []protocol.VolumeSpec{vol}
	pg := func(id string) protocol.WorkloadSpec {
		w := h.workload(id, map[string]string{"POSTGRES_PASSWORD": "it-only-password"})
		w.Image = postgresImage
		w.Ports = []protocol.WorkloadPort{{ContainerPort: 5432, Protocol: protocol.PortTCP}}
		w.Routes = nil
		w.Healthcheck = &protocol.Healthcheck{
			Type: protocol.HealthcheckExec, Command: []string{"pg_isready", "-h", "127.0.0.1", "-U", "postgres"},
			IntervalS: 1, TimeoutS: 5, Retries: 3, StartPeriodS: 60,
		}
		w.Mounts = []protocol.WorkloadMount{{VolumeID: vol.ID, Path: "/var/lib/postgresql/data"}}
		w.Rollout = protocol.RolloutStopFirst
		w.StopGraceS = ptr(30)
		w.Resources = protocol.Resources{CPUMillis: 1000, MemoryMB: 256, PIDs: 256}
		return rehash(w)
	}

	first := "wl_a" + h.ns
	vm.Apply(h.gen+1, h.volumes)
	h.apply(pg(first))
	a := h.waitState(first, protocol.StateHealthy, 3*time.Minute)
	psql(t, h.c, a.ContainerID, "CREATE TABLE t (id int); INSERT INTO t VALUES (1), (2), (3)")
	if _, err := os.Stat(filepath.Join(vm.DataPath(vol.ID), "PG_VERSION")); err != nil {
		t.Fatalf("the database did not write to the volume: %v", err)
	}

	// The next deployment: a new workload of the same service and volume.
	// At no moment may two containers run on the volume.
	var mounters atomic.Int32
	var wg sync.WaitGroup
	sampling, stopSampling := context.WithCancel(context.Background())
	wg.Add(1)
	go func() {
		defer wg.Done()
		for sampling.Err() == nil {
			list, err := h.c.ListContainers(context.Background(), runtime.LabelNamespace+"="+h.ns, runtime.LabelVolumes+"="+vol.ID)
			if err == nil {
				n := int32(0)
				for _, c := range list {
					if c.State == "running" {
						n++
					}
				}
				if n > mounters.Load() {
					mounters.Store(n)
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
	second := "wl_b" + h.ns
	vm.Apply(h.gen+1, h.volumes)
	h.apply(pg(second))
	b := h.waitState(second, protocol.StateHealthy, 3*time.Minute)
	stopSampling()
	wg.Wait()
	if n := mounters.Load(); n > 1 {
		t.Fatalf("%d containers ran on the volume at once", n)
	}
	if left := h.containers(first); len(left) != 0 {
		t.Fatalf("the old deployment's container is still there: %+v", left)
	}
	if got := psql(t, h.c, b.ContainerID, "SELECT count(*) FROM t"); got != "3" {
		t.Fatalf("rows after the handover: %q", got)
	}

	// A hold stops the database in place; releasing it starts it again.
	hctx, hcancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer hcancel()
	release, err := h.rt.Hold(hctx, "", vol.ID, "stopped for an integration test")
	if err != nil {
		t.Fatal(err)
	}
	info, err := h.c.InspectContainer(context.Background(), b.ContainerID)
	if err != nil || info.State.Running {
		t.Fatalf("held container: running=%v err=%v", info.State.Running, err)
	}
	release()
	if err := h.rt.WaitHealthy(hctx, second); err != nil {
		t.Fatal(err)
	}
	if got := psql(t, h.c, b.ContainerID, "SELECT count(*) FROM t"); got != "3" {
		t.Fatalf("rows after the hold: %q", got)
	}
	if !h.rt.VolumeInUse(vol.ID) {
		t.Fatal("VolumeInUse missed the database")
	}
	if err := vm.Delete(context.Background(), vol.ID); err == nil {
		t.Fatal("deleted a listed, mounted volume")
	}
}
