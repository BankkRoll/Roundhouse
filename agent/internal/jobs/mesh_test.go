package jobs

import (
	"slices"
	"sync"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/leaktest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeMesh is the mesh manager's view for the runner.
type fakeMesh struct {
	mu      sync.Mutex
	addr    string
	pending bool
	asked   int
	runs    [][]MeshRun
}

func (m *fakeMesh) PrivateDNS() (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.asked++
	return m.addr, m.pending
}

func (m *fakeMesh) set(addr string, pending bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.addr, m.pending = addr, pending
}

func (m *fakeMesh) report(rs []MeshRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.runs = append(m.runs, slices.Clone(rs))
}

func (m *fakeMesh) last() ([]MeshRun, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.runs) == 0 {
		return nil, false
	}
	return m.runs[len(m.runs)-1], true
}

func (m *fakeMesh) askedTimes() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.asked
}

func meshJob(runID string) *protocol.JobRun {
	m := jobRun(runID, 60, 1)
	m.Workload.MeshIP = "10.200.1.30"
	m.Workload.PrivateDNS = ptr(true)
	return m
}

func withMesh(m *fakeMesh) func(*Options) {
	return func(o *Options) {
		o.PrivateDNS = m.PrivateDNS
		o.MeshRuns = m.report
	}
}

func TestJobJoinsTheMeshWhileItRuns(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	mesh := &fakeMesh{pending: true}
	h := newHarness(t, d, t.TempDir(), withMesh(mesh))
	h.r.Start(meshJob("crn_1"))
	waitFor(t, "the run to wait for the mesh's DNS", func() bool { return mesh.askedTimes() > 1 })
	if d.count() != 0 {
		t.Fatal("container created while the mesh was coming up")
	}
	mesh.set("10.200.1.2", false)
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })
	c, _ := d.container(ContainerPrefix + "crn_1")
	if !slices.Equal(c.spec.HostConfig.DNS, []string{"10.200.1.2"}) {
		t.Errorf("HostConfig.Dns = %v", c.spec.HostConfig.DNS)
	}
	waitFor(t, "the run on the mesh", func() bool {
		rs, _ := mesh.last()
		return len(rs) == 1 && rs[0].MeshIP.String() == "10.200.1.30" && rs[0].BridgeIP.String() == c.ip
	})

	// It leaves the mesh as soon as it exits, before its status goes out.
	h.connected.Store(false)
	d.exit(c.id, 0)
	waitFor(t, "the run off the mesh", func() bool {
		rs, ok := mesh.last()
		return ok && len(rs) == 0
	})
	h.connected.Store(true)
	if st := h.waitFinal("crn_1"); st.State != protocol.JobSucceeded {
		t.Fatalf("status %+v", st)
	}
}

func TestJobPrivateDNSWithoutListener(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	mesh := &fakeMesh{}
	h := newHarness(t, d, t.TempDir(), withMesh(mesh))
	h.r.Start(meshJob("crn_1"))
	plain := jobRun("crn_2", 60, 1)
	h.r.Start(plain)
	waitFor(t, "both running", func() bool {
		return slices.Contains(h.states("crn_1"), protocol.JobRunning) && slices.Contains(h.states("crn_2"), protocol.JobRunning)
	})
	for _, id := range []string{"crn_1", "crn_2"} {
		if c, _ := d.container(ContainerPrefix + id); c.spec.HostConfig.DNS != nil {
			t.Errorf("%s: HostConfig.Dns = %v, want Docker's own", id, c.spec.HostConfig.DNS)
		}
	}
	// Without private_dns the mesh's DNS is never used, even when up.
	mesh.set("10.200.1.2", false)
	h.r.Start(jobRun("crn_3", 60, 1))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_3"), protocol.JobRunning) })
	if c, _ := d.container(ContainerPrefix + "crn_3"); c.spec.HostConfig.DNS != nil {
		t.Errorf("a run without private_dns got %v", c.spec.HostConfig.DNS)
	}
	// Only the run with a mesh IP is on the mesh.
	if rs, _ := mesh.last(); len(rs) != 1 || rs[0].MeshIP.String() != "10.200.1.30" {
		t.Errorf("mesh runs %v", rs)
	}
}

func TestJobStopsWaitingForAMeshThatNeverComes(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	mesh := &fakeMesh{pending: true}
	h := newHarness(t, d, t.TempDir(), withMesh(mesh))
	h.r.Start(meshJob("crn_1"))
	waitFor(t, "running", func() bool { return slices.Contains(h.states("crn_1"), protocol.JobRunning) })
	if c, _ := d.container(ContainerPrefix + "crn_1"); c.spec.HostConfig.DNS != nil {
		t.Errorf("HostConfig.Dns = %v", c.spec.HostConfig.DNS)
	}
}

func TestReattachedJobRejoinsTheMesh(t *testing.T) {
	leaktest.Check(t)
	d := newFakeDocker()
	dir := t.TempDir()
	mesh := &fakeMesh{addr: "10.200.1.2"}
	a := newHarness(t, d, dir, withMesh(mesh))
	a.r.Start(meshJob("crn_1"))
	waitFor(t, "the run on the mesh", func() bool { rs, _ := mesh.last(); return len(rs) == 1 })
	a.stop()

	again := &fakeMesh{}
	b := newHarness(t, d, dir, withMesh(again))
	c, _ := d.container(ContainerPrefix + "crn_1")
	waitFor(t, "the re-attached run on the mesh", func() bool {
		rs, _ := again.last()
		return len(rs) == 1 && rs[0].MeshIP.String() == "10.200.1.30" && rs[0].BridgeIP.String() == c.ip
	})
	d.exit(c.id, 0)
	b.waitFinal("crn_1")
	if rs, _ := again.last(); len(rs) != 0 {
		t.Errorf("finished run still on the mesh: %v", rs)
	}
}
