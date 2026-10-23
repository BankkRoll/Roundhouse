package runtime

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// fakeDocker is an in-memory engine. Started containers get an IP on their
// network and keep running until the test stops them, unless exitOnStart
// makes them exit immediately with that code.
type fakeDocker struct {
	mu         sync.Mutex
	containers map[string]*fakeContainer
	networks   map[string]docker.Network
	images     map[string]docker.ImageSummary // by ID
	refs       map[string]string              // ref → image ID
	nextID     int
	nextIP     int
	// exitOnStart maps an image to the exit code its containers die with.
	exitOnStart map[string]int
	// pullErr maps an image to a pull error.
	pullErr map[string]error
	pulls   []pullCall
	ops     []string
}

type fakeContainer struct {
	id      string
	name    string
	spec    docker.ContainerCreate
	created time.Time
	state   docker.ContainerState
	ip      string
	starts  []time.Time
}

type pullCall struct {
	ref  string
	auth *docker.AuthConfig
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{
		containers:  map[string]*fakeContainer{},
		networks:    map[string]docker.Network{},
		images:      map[string]docker.ImageSummary{},
		refs:        map[string]string{},
		exitOnStart: map[string]int{},
		pullErr:     map[string]error{},
	}
}

func (f *fakeDocker) op(format string, args ...any) {
	f.ops = append(f.ops, fmt.Sprintf(format, args...))
}

func notFound(what string) error { return &docker.Error{Status: 404, Message: "no such " + what} }

func (f *fakeDocker) ListContainers(_ context.Context, labels ...string) ([]docker.ContainerSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.ContainerSummary
	for _, c := range f.containers {
		match := true
		for _, l := range labels {
			k, v, _ := strings.Cut(l, "=")
			if c.spec.Labels[k] != v {
				match = false
			}
		}
		if match {
			out = append(out, docker.ContainerSummary{
				ID: c.id, Names: []string{"/" + c.name}, Image: c.spec.Image, ImageID: f.refs[c.spec.Image],
				Labels: maps.Clone(c.spec.Labels), State: c.state.Status, Created: c.created.Unix(),
			})
		}
	}
	return out, nil
}

func (f *fakeDocker) InspectContainer(_ context.Context, id string) (docker.ContainerInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.containers[id]
	if c == nil {
		return docker.ContainerInfo{}, notFound("container")
	}
	nets := map[string]docker.EndpointInfo{}
	if c.state.Running {
		nets[c.spec.HostConfig.NetworkMode] = docker.EndpointInfo{IPAddress: c.ip}
	}
	return docker.ContainerInfo{
		ID: c.id, Name: "/" + c.name, Created: c.created, Image: c.spec.Image, State: c.state,
		Config:          docker.ContainerConfig{Image: c.spec.Image, Labels: maps.Clone(c.spec.Labels)},
		NetworkSettings: docker.NetworkSettings{Networks: nets},
	}, nil
}

func (f *fakeDocker) CreateContainer(_ context.Context, name string, spec docker.ContainerCreate) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.containers {
		if c.name == name {
			return "", &docker.Error{Status: 409, Message: "name in use"}
		}
	}
	if _, ok := f.networks[spec.HostConfig.NetworkMode]; !ok {
		return "", notFound("network")
	}
	if _, ok := f.refs[spec.Image]; !ok {
		return "", notFound("image")
	}
	for _, binds := range spec.HostConfig.PortBindings {
		for _, b := range binds {
			for _, c := range f.containers {
				if c.state.Running && c.spec.HostConfig.PortBindings != nil {
					for _, other := range c.spec.HostConfig.PortBindings {
						for _, ob := range other {
							if ob.HostPort == b.HostPort {
								return "", &docker.Error{Status: 500, Message: "port is already allocated"}
							}
						}
					}
				}
			}
		}
	}
	f.nextID++
	id := fmt.Sprintf("%064x", f.nextID)
	f.containers[id] = &fakeContainer{
		id: id, name: name, spec: spec, created: time.Now().Add(time.Duration(f.nextID) * time.Microsecond),
		state: docker.ContainerState{Status: "created"},
	}
	f.op("create %s", name)
	return id, nil
}

func (f *fakeDocker) StartContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.containers[id]
	if c == nil {
		return notFound("container")
	}
	if c.state.Running {
		return nil
	}
	now := time.Now()
	c.starts = append(c.starts, now)
	f.op("start %s", c.name)
	if code, ok := f.exitOnStart[c.spec.Image]; ok {
		c.state = docker.ContainerState{Status: "exited", ExitCode: code, StartedAt: now, FinishedAt: now.Add(time.Millisecond)}
		return nil
	}
	f.nextIP++
	c.ip = fmt.Sprintf("10.0.0.%d", f.nextIP)
	c.state = docker.ContainerState{Status: "running", Running: true, StartedAt: now}
	return nil
}

func (f *fakeDocker) StopContainer(_ context.Context, id string, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.containers[id]
	if c == nil {
		return notFound("container")
	}
	f.op("stop %s", c.name)
	if c.state.Running {
		c.state = docker.ContainerState{Status: "exited", ExitCode: 0, StartedAt: c.state.StartedAt, FinishedAt: time.Now()}
	}
	return nil
}

func (f *fakeDocker) RemoveContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for cid, c := range f.containers {
		if cid == id || c.name == id {
			f.op("remove %s", c.name)
			delete(f.containers, cid)
		}
	}
	return nil
}

func (f *fakeDocker) InspectImage(_ context.Context, ref string) (docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, ok := f.refs[ref]
	if !ok {
		return docker.Image{}, notFound("image")
	}
	return docker.Image{ID: id}, nil
}

func (f *fakeDocker) PullImage(_ context.Context, ref string, auth *docker.AuthConfig) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pulls = append(f.pulls, pullCall{ref, auth})
	if err := f.pullErr[ref]; err != nil {
		return err
	}
	f.addImageLocked(ref, time.Now().Unix())
	return nil
}

func (f *fakeDocker) addImageLocked(ref string, created int64) string {
	id, ok := f.refs[ref]
	if !ok {
		id = fmt.Sprintf("sha256:%064x", len(f.refs)+1000)
		f.refs[ref] = id
	}
	f.images[id] = docker.ImageSummary{ID: id, RepoTags: []string{ref}, Created: created}
	return id
}

func (f *fakeDocker) ListImages(context.Context) ([]docker.ImageSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.ImageSummary
	for _, img := range f.images {
		out = append(out, img)
	}
	return out, nil
}

func (f *fakeDocker) RemoveImage(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.containers {
		if f.refs[c.spec.Image] == id {
			return &docker.Error{Status: 409, Message: "image is in use"}
		}
	}
	delete(f.images, id)
	for ref, rid := range f.refs {
		if rid == id {
			delete(f.refs, ref)
		}
	}
	f.op("rmi %s", id)
	return nil
}

func (f *fakeDocker) InspectNetwork(_ context.Context, name string) (docker.Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[name]
	if !ok {
		return docker.Network{}, notFound("network")
	}
	return n, nil
}

func (f *fakeDocker) CreateNetwork(_ context.Context, spec docker.NetworkCreate) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.networks[spec.Name]; ok {
		return "", &docker.Error{Status: 409, Message: "exists"}
	}
	f.networks[spec.Name] = docker.Network{ID: "net-" + spec.Name, Name: spec.Name, Driver: spec.Driver, Labels: spec.Labels, Options: spec.Options}
	f.op("network %s", spec.Name)
	return "net-" + spec.Name, nil
}

func (f *fakeDocker) ListNetworks(context.Context, ...string) ([]docker.Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.Network
	for _, n := range f.networks {
		out = append(out, n)
	}
	return out, nil
}

func (f *fakeDocker) RemoveNetwork(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.networks, name)
	return nil
}

func (f *fakeDocker) Events(ctx context.Context, _ map[string][]string, _ func(docker.Event)) error {
	<-ctx.Done()
	return nil
}

func (f *fakeDocker) Info(context.Context) (docker.Info, error) {
	return docker.Info{DockerRootDir: "/var/lib/docker"}, nil
}

// crash makes a running container exit with code.
func (f *fakeDocker) crash(id string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.containers[id]
	c.state = docker.ContainerState{Status: "exited", ExitCode: code, StartedAt: c.state.StartedAt, FinishedAt: time.Now()}
}

// byWorkload returns the containers of a workload, oldest first.
func (f *fakeDocker) byWorkload(id string) []*fakeContainer {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*fakeContainer
	for _, c := range f.containers {
		if c.spec.Labels[LabelWorkloadID] == id {
			cp := *c
			out = append(out, &cp)
		}
	}
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j].created.Before(out[i].created) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

func (f *fakeDocker) opLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ops...)
}

// fakeIngress records every config it is given.
type fakeIngress struct {
	mu      sync.Mutex
	configs []ingress.Config
	f       *fakeDocker
}

func (i *fakeIngress) Apply(_ context.Context, c ingress.Config) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if len(i.configs) == 0 || fmt.Sprint(i.configs[len(i.configs)-1].Routes) != fmt.Sprint(c.Routes) {
		i.configs = append(i.configs, c)
		if i.f != nil {
			i.f.mu.Lock()
			i.f.op("routes %v", c.Routes)
			i.f.mu.Unlock()
		}
	}
	return nil
}

func (i *fakeIngress) all() []ingress.Config {
	i.mu.Lock()
	defer i.mu.Unlock()
	return slices.Clone(i.configs)
}

func (i *fakeIngress) last() ingress.Config {
	i.mu.Lock()
	defer i.mu.Unlock()
	if len(i.configs) == 0 {
		return ingress.Config{}
	}
	return i.configs[len(i.configs)-1]
}

// probes decides health by IP; unknown IPs fail.
type probes struct {
	mu sync.Mutex
	ok map[string]bool
}

func (p *probes) set(ip string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ok[ip] = ok
}

func (p *probes) probe(_ context.Context, _ protocol.Healthcheck, ip string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ok[ip] {
		return nil
	}
	return fmt.Errorf("probe %s failed", ip)
}

// statusLog records every reported status.
type statusLog struct {
	mu   sync.Mutex
	reps []protocol.WorkloadStatusReport
}

func (s *statusLog) report(_ context.Context, r protocol.WorkloadStatusReport) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reps = append(s.reps, r)
}

func (s *statusLog) states(id string) []protocol.WorkloadState {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []protocol.WorkloadState
	for _, r := range s.reps {
		if r.WorkloadID == id && (len(out) == 0 || out[len(out)-1] != r.State) {
			out = append(out, r.State)
		}
	}
	return out
}

func (s *statusLog) lastOf(id string) (protocol.WorkloadStatusReport, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.reps) - 1; i >= 0; i-- {
		if s.reps[i].WorkloadID == id {
			return s.reps[i], true
		}
	}
	return protocol.WorkloadStatusReport{}, false
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
