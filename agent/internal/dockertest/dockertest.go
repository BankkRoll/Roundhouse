// Package dockertest holds helpers for the agent's Docker integration tests
// (build tag integration).
//
// The tests run inside a Linux container that shares the host's Docker
// socket (see agent/test/integration.sh). They reach the containers they
// start by IP, which works only on a shared network, so [Attach] connects
// the test's own container to a network for the duration of a test.
package dockertest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
)

// Images used by the integration tests, pinned so runs are reproducible.
const (
	WhoamiImage  = "traefik/whoami:v1.11.0@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab"
	BusyboxImage = "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
	CaddyImage   = "caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f"
)

// TestLabel marks everything a test creates, so cleanup can find leftovers.
const TestLabel = "roundhouse.test"

// Client returns a client for DOCKER_HOST and fails the test if the engine
// does not answer.
func Client(t testing.TB) *docker.Client {
	t.Helper()
	c, err := docker.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("docker engine unavailable: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

// Unique returns prefix with a random suffix that is valid in IDs, names and
// labels.
func Unique(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// Self returns the ID of the container the test runs in. Docker sets a
// container's hostname to its short ID.
func Self(t testing.TB, c *docker.Client) string {
	t.Helper()
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	info, err := c.InspectContainer(context.Background(), host)
	if err != nil {
		t.Fatalf("the integration tests must run inside a container on the engine they drive (see agent/test/integration.sh): %v", err)
	}
	return info.ID
}

// Network creates a bridge network and removes it after the test.
func Network(t testing.TB, c *docker.Client, name string, labels map[string]string) {
	t.Helper()
	ctx := context.Background()
	l := map[string]string{TestLabel: "true"}
	for k, v := range labels {
		l[k] = v
	}
	if _, err := c.CreateNetwork(ctx, docker.NetworkCreate{Name: name, Driver: "bridge", Labels: l}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.RemoveNetwork(context.Background(), name) })
}

// Attach connects the test's own container to network until the test ends.
func Attach(t testing.TB, c *docker.Client, network string) {
	t.Helper()
	self := Self(t, c)
	if err := c.ConnectNetwork(context.Background(), network, self); err != nil && !strings.Contains(err.Error(), "already exists") {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.DisconnectNetwork(context.Background(), network, self) })
}

// Pull pulls ref unless it is already present.
func Pull(t testing.TB, c *docker.Client, ref string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if _, err := c.InspectImage(ctx, ref); err == nil {
		return
	}
	if err := c.PullImage(ctx, ref, nil); err != nil {
		t.Fatalf("pull %s: %v", ref, err)
	}
}

// Run creates and starts a container that is removed after the test, and
// returns its ID.
func Run(t testing.TB, c *docker.Client, name string, spec docker.ContainerCreate) string {
	t.Helper()
	ctx := context.Background()
	Pull(t, c, spec.Image)
	if spec.Labels == nil {
		spec.Labels = map[string]string{}
	}
	spec.Labels[TestLabel] = "true"
	id, err := c.CreateContainer(ctx, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.RemoveContainer(context.Background(), id) })
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

// IP returns a running container's address on network.
func IP(t testing.TB, c *docker.Client, id, network string) string {
	t.Helper()
	info, err := c.InspectContainer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	ip := info.NetworkSettings.Networks[network].IPAddress
	if ip == "" {
		t.Fatalf("container %s has no address on %s", id, network)
	}
	return ip
}

// RemoveLabelled force-removes every container carrying label (key=value),
// for cleanup after code under test created containers.
func RemoveLabelled(c *docker.Client, label string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	list, err := c.ListContainers(ctx, label)
	if err != nil {
		return
	}
	for _, ct := range list {
		_ = c.RemoveContainer(ctx, ct.ID)
	}
}

// Eventually polls cond until it holds or timeout passes.
func Eventually(t testing.TB, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", timeout, what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
