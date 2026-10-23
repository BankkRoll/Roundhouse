//go:build integration

package docker_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
)

func TestEngine(t *testing.T) {
	c := dockertest.Client(t)
	ctx := context.Background()

	v, err := c.Version(ctx)
	if err != nil || v.Version == "" {
		t.Fatalf("version %+v, %v", v, err)
	}
	info, err := c.Info(ctx)
	if err != nil || info.DockerRootDir == "" {
		t.Fatalf("info %+v, %v", info, err)
	}

	dockertest.Pull(t, c, dockertest.BusyboxImage)
	img, err := c.InspectImage(ctx, dockertest.BusyboxImage)
	if err != nil || !strings.HasPrefix(img.ID, "sha256:") {
		t.Fatalf("inspect image %+v, %v", img, err)
	}
	if _, err := c.InspectImage(ctx, "roundhouse/does-not-exist:1"); !docker.IsNotFound(err) {
		t.Fatalf("missing image: %v", err)
	}
	if err := c.PullImage(ctx, "roundhouse-integration/does-not-exist:1", nil); err == nil {
		t.Fatal("pulling a missing image succeeded")
	}

	net := dockertest.Unique("roundhouse-it-net-")
	dockertest.Network(t, c, net, nil)
	if _, err := c.CreateNetwork(ctx, docker.NetworkCreate{Name: net, Driver: "bridge"}); !docker.IsConflict(err) {
		t.Fatalf("duplicate network: %v", err)
	}
	n, err := c.InspectNetwork(ctx, net)
	if err != nil || n.Name != net {
		t.Fatalf("inspect network %+v, %v", n, err)
	}

	// Events for the container below, collected from before it exists.
	evCtx, stopEvents := context.WithCancel(ctx)
	var mu sync.Mutex
	var actions []string
	evDone := make(chan error, 1)
	go func() {
		evDone <- c.Events(evCtx, map[string][]string{"type": {"container"}, "label": {"roundhouse.it=events"}}, func(e docker.Event) {
			mu.Lock()
			actions = append(actions, e.Action)
			mu.Unlock()
		})
	}()
	time.Sleep(200 * time.Millisecond)

	pids := int64(32)
	name := dockertest.Unique("roundhouse-it-ctr-")
	id := dockertest.Run(t, c, name, docker.ContainerCreate{
		Image:      dockertest.BusyboxImage,
		Cmd:        []string{"sh", "-c", "echo out-1; echo err-1 >&2; echo out-2; sleep 30"},
		Labels:     map[string]string{"roundhouse.it": "events"},
		HostConfig: docker.HostConfig{NetworkMode: net, CapDrop: []string{"ALL"}, PidsLimit: &pids, SecurityOpt: []string{"no-new-privileges:true"}},
	})
	list, err := c.ListContainers(ctx, "roundhouse.it=events")
	if err != nil || len(list) != 1 || list[0].ID != id || list[0].State != "running" {
		t.Fatalf("list %+v, %v", list, err)
	}
	ci, err := c.InspectContainer(ctx, id)
	if err != nil || !ci.State.Running || ci.NetworkSettings.Networks[net].IPAddress == "" || ci.Name != "/"+name {
		t.Fatalf("inspect %+v, %v", ci, err)
	}

	// Follow the multiplexed log stream until both streams arrived.
	logCtx, stopLogs := context.WithTimeout(ctx, 20*time.Second)
	rc, err := c.ContainerLogs(logCtx, id, docker.LogsOptions{Follow: true, Timestamps: true})
	if err != nil {
		t.Fatal(err)
	}
	d := docker.NewDemuxer(rc)
	got := map[docker.StreamType][]string{}
	for len(got[docker.Stdout]) < 2 || len(got[docker.Stderr]) < 1 {
		st, p, err := d.Next()
		if err != nil {
			t.Fatalf("logs: %v (got %v)", err, got)
		}
		_, text, _ := strings.Cut(strings.TrimSpace(string(p)), " ")
		got[st] = append(got[st], text)
	}
	stopLogs()
	rc.Close()
	if strings.Join(got[docker.Stdout], ",") != "out-1,out-2" || got[docker.Stderr][0] != "err-1" {
		t.Fatalf("demuxed %v", got)
	}

	if err := c.StopContainer(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	if err := c.StopContainer(ctx, id, time.Second); err != nil {
		t.Fatalf("stopping a stopped container: %v", err)
	}
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatalf("starting a running container: %v", err)
	}
	if err := c.RemoveContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := c.InspectContainer(ctx, id); !docker.IsNotFound(err) {
		t.Fatalf("removed container: %v", err)
	}
	dockertest.Eventually(t, 10*time.Second, "destroy event", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return strings.Contains(strings.Join(actions, ","), "destroy")
	})
	stopEvents()
	if err := <-evDone; err != nil {
		t.Fatalf("events: %v", err)
	}
	mu.Lock()
	seq := strings.Join(actions, ",")
	mu.Unlock()
	for _, want := range []string{"create", "start", "die"} {
		if !strings.Contains(seq, want) {
			t.Errorf("no %s event in %s", want, seq)
		}
	}
}

func TestLogsOfMissingContainer(t *testing.T) {
	c := dockertest.Client(t)
	_, err := c.ContainerLogs(context.Background(), "roundhouse-missing", docker.LogsOptions{})
	if !docker.IsNotFound(err) {
		t.Fatalf("err = %v", err)
	}
	var e *docker.Error
	if !errors.As(err, &e) || e.Message == "" {
		t.Fatalf("error has no message: %v", err)
	}
}
