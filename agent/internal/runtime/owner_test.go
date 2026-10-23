package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const thisNode = "node_this"

// nodeHarness runs a runtime the way the agent does: namespaced by node ID,
// adopting unlabelled containers.
func nodeHarness(t *testing.T, d *fakeDocker, dataDir string) *harness {
	t.Helper()
	h := newHarness(t, func(o *Options) {
		if d != nil {
			o.Docker = d
		}
		o.Namespace = thisNode
		o.AdoptUnlabelled = true
		o.DataDir = dataDir
	})
	if d != nil {
		h.d = d
		h.ing.mu.Lock()
		h.ing.f = d
		h.ing.mu.Unlock()
	}
	return h
}

// plant creates and starts a container as another agent would have, with
// the given labels on top of a managed workload's.
func plant(t *testing.T, d *fakeDocker, name, network string, labels map[string]string) string {
	t.Helper()
	ctx := context.Background()
	d.mu.Lock()
	d.addImageLocked("traefik/whoami:v1.10", 1)
	d.mu.Unlock()
	if _, err := d.CreateNetwork(ctx, docker.NetworkCreate{Name: network}); err != nil && !docker.IsConflict(err) {
		t.Fatal(err)
	}
	l := map[string]string{LabelManaged: "true", LabelKind: string(protocol.WorkloadService), LabelNetwork: network}
	for k, v := range labels {
		l[k] = v
	}
	id, err := d.CreateContainer(ctx, name, docker.ContainerCreate{
		Image: "traefik/whoami:v1.10", Labels: l, HostConfig: docker.HostConfig{NetworkMode: network},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func exists(d *fakeDocker, id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.containers[id]
	return ok
}

// An agent sharing its engine with another node must leave that node's
// containers alone, and must not remove unlabelled containers it was never
// asked to run, even with an empty desired state.
func TestNamespaceLeavesOtherNodesAlone(t *testing.T) {
	d := newFakeDocker()
	foreign := plant(t, d, "other-node", "roundhouse-prj_x-env_x", map[string]string{
		LabelWorkloadID: "wl_foreign", LabelNamespace: "node_other", LabelSpecHash: strings.Repeat("1", 64),
	})
	stray := plant(t, d, "phase1-stray", "roundhouse-prj_x", map[string]string{
		LabelWorkloadID: "wl_stray", LabelSpecHash: strings.Repeat("2", 64),
	})

	h := nodeHarness(t, d, t.TempDir())
	w := spec("wl_mine", "svc_web")
	w.Healthcheck = nil
	h.rt.Apply(desired(1, w))
	h.waitState("wl_mine", protocol.StateHealthy)
	time.Sleep(200 * time.Millisecond)

	if !exists(d, foreign) || !exists(d, stray) {
		t.Fatalf("removed a container that is not this node's: %v", d.opLog())
	}
	for _, s := range h.rt.Statuses() {
		if s.WorkloadID == "wl_foreign" || s.WorkloadID == "wl_stray" {
			t.Errorf("reported a container that is not this node's: %+v", s)
		}
	}
	mine := h.running("wl_mine")
	if mine.spec.Labels[LabelNamespace] != thisNode {
		t.Errorf("created container lacks the node namespace: %v", mine.spec.Labels)
	}
	n := d.networks[w.Network]
	if n.Labels[LabelNamespace] != thisNode || n.Labels[LabelEnvironmentID] != "env_1" {
		t.Errorf("environment network labels %v", n.Labels)
	}
}

// Without a namespace (the Phase 1 behaviour) the same stray container would
// be removed; this pins down what the namespace fixes.
func TestWithoutNamespaceStrayIsRemoved(t *testing.T) {
	d := newFakeDocker()
	stray := plant(t, d, "phase1-stray", "roundhouse-prj_x", map[string]string{
		LabelWorkloadID: "wl_stray", LabelSpecHash: strings.Repeat("2", 64),
	})
	h := newHarness(t, func(o *Options) { o.Docker = d })
	h.d = d
	h.rt.Apply(desired(1))
	eventually(t, "the stray container to be removed", func() bool { return !exists(d, stray) })
}

// A Phase 1 container (no namespace, project network) whose workload is
// desired is adopted, replaced by a namespaced container on the environment
// network with zero downtime, then removed; the project network goes too.
func TestLegacyContainerIsAdoptedAndMigrated(t *testing.T) {
	d := newFakeDocker()
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	legacy := w
	legacy.Network = protocol.ProjectNetworkName("prj_1")
	legacy = rehash(legacy)
	old := plant(t, d, "roundhouse-wl_a-old", legacy.Network, map[string]string{
		LabelWorkloadID: "wl_a", LabelSpecHash: legacy.SpecHash, LabelDeploymentID: "dep_a",
		LabelServiceID: "svc_web", LabelProjectID: "prj_1", LabelEnvironmentID: "env_1",
		LabelRoutes: `[{"hostname":"app.example.com","container_port":80}]`,
	})
	d.mu.Lock()
	d.networks[legacy.Network] = docker.Network{Name: legacy.Network, Labels: map[string]string{LabelManaged: "true", LabelProjectID: "prj_1"}}
	d.networks["roundhouse-prj_other"] = docker.Network{Name: "roundhouse-prj_other", Labels: map[string]string{LabelManaged: "true", LabelProjectID: "prj_other"}}
	d.mu.Unlock()
	defer func(was time.Duration) { networkGCInterval = was }(networkGCInterval)
	networkGCInterval = 0
	if legacy.SpecHash == w.SpecHash {
		t.Fatal("moving to the environment network must change the spec hash")
	}

	dir := t.TempDir()
	h := nodeHarness(t, d, dir)
	h.rt.Apply(desired(1, w))
	var next *fakeContainer
	eventually(t, "a replacement for the adopted container", func() bool {
		for _, c := range d.byWorkload("wl_a") {
			if c.id != old && c.state.Running {
				next = c
			}
		}
		return next != nil
	})
	if next.spec.HostConfig.NetworkMode != w.Network || next.spec.Labels[LabelNamespace] != thisNode {
		t.Fatalf("replacement %s on %s labels %v", next.id, next.spec.HostConfig.NetworkMode, next.spec.Labels)
	}
	eventually(t, "the adopted container to be removed", func() bool { return !exists(d, old) })
	if r := h.ing.last().Routes; len(r) != 1 || r[0].Upstreams[0] != next.ip+":80" {
		t.Fatalf("routes after migration %v", r)
	}
	eventually(t, "the unused project network to be removed", func() bool {
		_, err := d.InspectNetwork(context.Background(), legacy.Network)
		return docker.IsNotFound(err)
	})
	if _, err := d.InspectNetwork(context.Background(), "roundhouse-prj_other"); err != nil {
		t.Error("removed the project network of a project this node does not run")
	}
	if _, err := d.InspectNetwork(context.Background(), w.Network); err != nil {
		t.Error("removed the environment network in use")
	}
	ops := strings.Join(d.opLog(), "\n")
	if !strings.Contains(ops, "routes [{app.example.com  ["+next.ip+":80] [80]}]") {
		t.Fatalf("routes never switched to the replacement:\n%s", ops)
	}
}

// Once adopted, a container stays this node's across restarts, so it is
// still removed after its workload is dropped while the agent was down.
func TestAdoptionSurvivesRestart(t *testing.T) {
	d := newFakeDocker()
	w := spec("wl_a", "svc_web")
	w.Healthcheck = nil
	old := plant(t, d, "roundhouse-wl_a-"+w.SpecHash[:12], w.Network, map[string]string{
		LabelWorkloadID: "wl_a", LabelSpecHash: w.SpecHash, LabelDeploymentID: "dep_a",
		LabelServiceID: "svc_web", LabelProjectID: "prj_1", LabelEnvironmentID: "env_1",
	})
	dir := t.TempDir()
	h := nodeHarness(t, d, dir)
	h.rt.Apply(desired(1, w))
	h.waitState("wl_a", protocol.StateHealthy)
	if c := h.running("wl_a"); c.id != old {
		t.Fatalf("an adopted container running the same spec was replaced by %s", c.id)
	}
	eventually(t, "the adoption to be persisted", func() bool {
		data, err := os.ReadFile(filepath.Join(dir, adoptedFile))
		return err == nil && strings.Contains(string(data), old)
	})
	h.stop()

	h2 := nodeHarness(t, d, dir)
	h2.rt.Apply(desired(2))
	eventually(t, "the adopted container to be removed after its workload was dropped", func() bool { return !exists(d, old) })
	eventually(t, "the adoption record to be pruned", func() bool {
		data, err := os.ReadFile(filepath.Join(dir, adoptedFile))
		return err == nil && !strings.Contains(string(data), old)
	})
}

// Without the adoption record, a container whose workload is not desired is
// not this node's to remove.
func TestUnadoptedLegacyContainerIsKept(t *testing.T) {
	d := newFakeDocker()
	legacy := plant(t, d, "roundhouse-wl_gone-x", "roundhouse-prj_1", map[string]string{
		LabelWorkloadID: "wl_gone", LabelSpecHash: strings.Repeat("3", 64),
	})
	h := nodeHarness(t, d, t.TempDir())
	h.rt.Apply(desired(1))
	time.Sleep(200 * time.Millisecond)
	if !exists(d, legacy) {
		t.Fatal("removed an unlabelled container this node never adopted")
	}
}
