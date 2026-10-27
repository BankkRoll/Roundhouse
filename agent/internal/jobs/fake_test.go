package jobs

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
)

// behaviour is what a fake container of an image does once started. The
// default runs until SIGKILL and ignores SIGTERM.
type behaviour struct {
	// lines are printed to stdout at start.
	lines []string
	// exit, when set, ends the container right after start.
	exit *int
	oom  bool
	// termExits makes SIGTERM end it with 143.
	termExits bool
}

type fakeLine struct {
	ts     time.Time
	stream docker.StreamType
	text   string
}

type fakeContainer struct {
	id      string
	name    string
	spec    docker.ContainerCreate
	state   docker.ContainerState
	exited  chan struct{}
	logs    []fakeLine
	signals []string
	// ip is its address on its network while it runs.
	ip string
}

// fakeDocker is an in-memory engine for the runner.
type fakeDocker struct {
	mu         sync.Mutex
	containers map[string]*fakeContainer
	images     map[string]bool
	behave     map[string]behaviour
	// blockPull makes pulls of an image wait for their context.
	blockPull map[string]bool
	pullErr   map[string]error
	pulls     []string
	// createErrs are returned by the next creates, in order.
	createErrs []error
	nextID     int
}

func newFakeDocker() *fakeDocker {
	return &fakeDocker{
		containers: map[string]*fakeContainer{}, images: map[string]bool{}, behave: map[string]behaviour{},
		blockPull: map[string]bool{}, pullErr: map[string]error{},
	}
}

func notFound(what string) error { return &docker.Error{Status: 404, Message: "no such " + what} }

func (f *fakeDocker) find(ref string) *fakeContainer {
	if c := f.containers[ref]; c != nil {
		return c
	}
	for _, c := range f.containers {
		if c.name == ref {
			return c
		}
	}
	return nil
}

func (f *fakeDocker) ListContainers(_ context.Context, labels ...string) ([]docker.ContainerSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.ContainerSummary
	for _, c := range f.containers {
		match := true
		for _, l := range labels {
			k, v, _ := strings.Cut(l, "=")
			if got, ok := c.spec.Labels[k]; !ok || got != v {
				match = false
			}
		}
		if match {
			out = append(out, docker.ContainerSummary{ID: c.id, Names: []string{"/" + c.name}, Labels: c.spec.Labels, State: c.state.Status})
		}
	}
	return out, nil
}

func (f *fakeDocker) InspectContainer(_ context.Context, id string) (docker.ContainerInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil {
		return docker.ContainerInfo{}, notFound("container")
	}
	info := docker.ContainerInfo{ID: c.id, Name: "/" + c.name, State: c.state,
		Config: docker.ContainerConfig{Image: c.spec.Image, Labels: c.spec.Labels, Env: c.spec.Env}}
	if c.state.Running && c.spec.NetworkingConfig != nil {
		info.NetworkSettings.Networks = map[string]docker.EndpointInfo{}
		for name := range c.spec.NetworkingConfig.EndpointsConfig {
			info.NetworkSettings.Networks[name] = docker.EndpointInfo{IPAddress: c.ip}
		}
	}
	return info, nil
}

func (f *fakeDocker) CreateContainer(ctx context.Context, name string, spec docker.ContainerCreate) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.createErrs) > 0 {
		err := f.createErrs[0]
		f.createErrs = f.createErrs[1:]
		return "", err
	}
	if !f.images[spec.Image] {
		return "", notFound("image")
	}
	if f.find(name) != nil {
		return "", &docker.Error{Status: 409, Message: "name in use"}
	}
	f.nextID++
	id := fmt.Sprintf("%064x", f.nextID)
	f.containers[id] = &fakeContainer{id: id, name: name, spec: spec, exited: make(chan struct{}), ip: fmt.Sprintf("172.30.0.%d", f.nextID+1),
		state: docker.ContainerState{Status: "created"}}
	return id, ctx.Err()
}

func (f *fakeDocker) StartContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil {
		return notFound("container")
	}
	c.state = docker.ContainerState{Status: "running", Running: true, StartedAt: time.Now(), Pid: 1}
	b := f.behave[c.spec.Image]
	for _, l := range b.lines {
		c.logs = append(c.logs, fakeLine{ts: time.Now(), stream: docker.Stdout, text: l})
	}
	if b.exit != nil {
		c.state.OOMKilled = b.oom
		f.exitLocked(c, *b.exit)
	}
	return nil
}

// exitLocked ends c with code. Caller holds f.mu.
func (f *fakeDocker) exitLocked(c *fakeContainer, code int) {
	if !c.state.Running {
		return
	}
	c.state.Running, c.state.Status, c.state.ExitCode, c.state.FinishedAt = false, "exited", code, time.Now()
	c.state.Pid = 0
	close(c.exited)
}

// exit ends container id with code, as if its process returned.
func (f *fakeDocker) exit(id string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(id); c != nil {
		f.exitLocked(c, code)
	}
}

// print adds a stdout line to container id's logs.
func (f *fakeDocker) print(id, text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c := f.find(id); c != nil {
		c.logs = append(c.logs, fakeLine{ts: time.Now(), stream: docker.Stdout, text: text})
	}
}

func (f *fakeDocker) KillContainer(_ context.Context, id, signal string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil {
		return notFound("container")
	}
	if !c.state.Running {
		return &docker.Error{Status: 409, Message: "not running"}
	}
	c.signals = append(c.signals, signal)
	switch {
	case signal == "SIGKILL":
		f.exitLocked(c, 137)
	case signal == "SIGTERM" && f.behave[c.spec.Image].termExits:
		f.exitLocked(c, 143)
	}
	return nil
}

func (f *fakeDocker) WaitContainer(ctx context.Context, id, _ string) (int, error) {
	f.mu.Lock()
	c := f.find(id)
	f.mu.Unlock()
	if c == nil {
		return 0, notFound("container")
	}
	select {
	case <-c.exited:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.find(id) == nil {
		return 0, notFound("container")
	}
	return c.state.ExitCode, nil
}

func (f *fakeDocker) RemoveContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(id)
	if c == nil {
		return nil
	}
	f.exitLocked(c, 137)
	delete(f.containers, c.id)
	return nil
}

func (f *fakeDocker) InspectImage(_ context.Context, ref string) (docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.images[ref] {
		return docker.Image{}, notFound("image")
	}
	return docker.Image{ID: "sha256:" + ref}, nil
}

func (f *fakeDocker) PullImage(ctx context.Context, ref string, _ *docker.AuthConfig) error {
	f.mu.Lock()
	f.pulls = append(f.pulls, ref)
	block, err := f.blockPull[ref], f.pullErr[ref]
	f.mu.Unlock()
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.images[ref] = true
	f.mu.Unlock()
	return nil
}

func (f *fakeDocker) ContainerLogs(ctx context.Context, id string, opts docker.LogsOptions) (io.ReadCloser, error) {
	f.mu.Lock()
	c := f.find(id)
	f.mu.Unlock()
	if c == nil {
		return nil, notFound("container")
	}
	pr, pw := io.Pipe()
	go func() {
		next := 0
		write := func() error {
			f.mu.Lock()
			lines := c.logs[next:]
			next = len(c.logs)
			f.mu.Unlock()
			for _, l := range lines {
				if !opts.Since.IsZero() && l.ts.Before(opts.Since) {
					continue
				}
				payload := l.ts.UTC().Format(time.RFC3339Nano) + " " + l.text + "\n"
				hdr := make([]byte, 8)
				hdr[0] = byte(l.stream)
				binary.BigEndian.PutUint32(hdr[4:], uint32(len(payload)))
				if _, err := pw.Write(append(hdr, payload...)); err != nil {
					return err
				}
			}
			return nil
		}
		for {
			if err := write(); err != nil {
				return
			}
			select {
			case <-c.exited:
				if write() == nil {
					pw.Close()
				}
				return
			case <-ctx.Done():
				pw.CloseWithError(ctx.Err())
				return
			case <-time.After(5 * time.Millisecond):
			}
			if !opts.Follow {
				pw.Close()
				return
			}
		}
	}()
	return pr, nil
}

// container returns a copy of the state of the container named name.
func (f *fakeDocker) container(name string) (fakeContainer, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.find(name)
	if c == nil {
		return fakeContainer{}, false
	}
	cp := *c
	cp.signals = append([]string(nil), c.signals...)
	return cp, true
}

func (f *fakeDocker) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.containers)
}
