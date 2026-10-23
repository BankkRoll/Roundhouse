//go:build integration

package logship_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/logship"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

type collector struct {
	mu    sync.Mutex
	lines []protocol.LogLine
}

func (c *collector) send(_ context.Context, l *protocol.Logs) error {
	if err := l.Validate(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, l.Lines...)
	return nil
}

func (c *collector) texts() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.lines))
	for i, l := range c.lines {
		out[i] = string(l.Stream) + ":" + l.Text
	}
	return out
}

// TestFollowRealContainerAcrossRestarts runs a container that prints a few
// lines and exits, ships them, restarts it, and expects exactly the new
// lines: the restart must not replay what was already shipped.
func TestFollowRealContainerAcrossRestarts(t *testing.T) {
	c := dockertest.Client(t)
	ctx := context.Background()
	id := dockertest.Run(t, c, dockertest.Unique("roundhouse-it-logs-"), docker.ContainerCreate{
		Image: dockertest.BusyboxImage,
		Cmd: []string{"sh", "-c",
			`for i in 1 2 3; do echo "out $i"; echo "err $i" >&2; done; sleep 1`},
	})
	inspect := func() docker.ContainerInfo {
		info, err := c.InspectContainer(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}

	out := &collector{}
	s, err := logship.New(logship.Options{Docker: c, Send: out.send, Dir: t.TempDir(), FlushInterval: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- s.Run(runCtx) }()
	defer func() {
		cancel()
		<-done
	}()
	syncTargets := func() {
		info := inspect()
		s.Sync([]logship.Target{{
			ContainerID: id, WorkloadID: "wl_it", DeploymentID: "dep_it",
			Running: info.State.Running, StartedAt: info.State.StartedAt,
		}})
	}
	syncTargets()
	dockertest.Eventually(t, 30*time.Second, "the first run's lines", func() bool { return len(out.texts()) == 6 })

	dockertest.Eventually(t, 30*time.Second, "the container to exit", func() bool { return !inspect().State.Running })
	syncTargets()
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	syncTargets()
	dockertest.Eventually(t, 30*time.Second, "the second run's lines", func() bool { return len(out.texts()) == 12 })
	time.Sleep(time.Second)
	syncTargets()
	time.Sleep(500 * time.Millisecond)

	got := out.texts()
	if len(got) != 12 {
		t.Fatalf("got %d lines (duplicates?): %v", len(got), got)
	}
	var want []string
	for i := 1; i <= 3; i++ {
		want = append(want, fmt.Sprintf("stdout:out %d", i), fmt.Sprintf("stderr:err %d", i))
	}
	for run := 0; run < 2; run++ {
		half := slices.Clone(got[run*6 : run*6+6])
		slices.Sort(half)
		w := slices.Clone(want)
		slices.Sort(w)
		if !slices.Equal(half, w) {
			t.Fatalf("run %d lines %v, want %v", run+1, half, w)
		}
	}
	if strings.Contains(strings.Join(got, "\n"), "Z ") {
		t.Fatalf("timestamp prefix leaked into text: %v", got)
	}
}
