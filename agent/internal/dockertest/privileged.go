package dockertest

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
)

// PrivilegedEnv is set to "1" in the sibling container [RunPrivileged]
// starts, where a test's privileged half runs.
const PrivilegedEnv = "ROUNDHOUSE_IT_PRIVILEGED"

// Scratch is the directory agent/test/integration.sh mounts at the same path
// in the test container and on the daemon's host, so a sibling container can
// bind what a test writes there.
const Scratch = "/var/lib/roundhouse-it"

// InPrivileged reports whether the test runs as the privileged half started
// by [RunPrivileged].
func InPrivileged() bool { return os.Getenv(PrivilegedEnv) == "1" }

// SkipUnlessPrivileged skips a test's privileged half when it runs anywhere
// but the sibling container [RunPrivileged] starts, e.g. when a -run pattern
// for the outer test also matches it.
func SkipUnlessPrivileged(t testing.TB) {
	t.Helper()
	if !InPrivileged() {
		t.Skip("runs only inside the privileged container dockertest.RunPrivileged starts")
	}
}

// Privileged configures [RunPrivileged].
type Privileged struct {
	// Test is the name of the test function to run there.
	Test string
	// Packages are Debian packages installed before the test runs.
	Packages []string
	// Setup is a shell snippet run as root after the packages are installed.
	Setup string
	// Timeout bounds the whole run; zero means 10 minutes.
	Timeout time.Duration
}

var testName = regexp.MustCompile(`^Test[A-Za-z0-9_]*$`)

// RunPrivileged runs one test of the current test binary in a privileged
// sibling container and fails the test if it fails, or skips it if it
// skips. It returns the test's verbose output.
//
// The integration tests run in an unprivileged container, which can't touch
// netfilter or mount filesystems. RunPrivileged copies the running test
// binary into a fresh directory under [Scratch], starts a privileged
// container from the image the test itself runs in (so the binary's libc
// matches), installs p.Packages, runs p.Setup and then the binary with
// -test.run '^<p.Test>$' and [PrivilegedEnv]=1. The privileged test should
// call [SkipUnlessPrivileged] first. The container and the directory are
// removed after the test. The sibling has its own network namespace, so
// what it does to netfilter never reaches the host's.
func RunPrivileged(t testing.TB, c *docker.Client, p Privileged) string {
	t.Helper()
	if !testName.MatchString(p.Test) {
		t.Fatalf("invalid test name %q", p.Test)
	}
	for _, pkg := range p.Packages {
		if strings.ContainsAny(pkg, " '\"\\$;&|`") {
			t.Fatalf("invalid package name %q", pkg)
		}
	}
	timeout := p.Timeout
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	self, err := c.InspectContainer(ctx, Self(t, c))
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(Scratch, Unique("priv-"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create %s (is %s mounted, as integration.sh does?): %v", dir, Scratch, err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := copyFile(exe, filepath.Join(dir, "test.bin")); err != nil {
		t.Fatal(err)
	}

	var script strings.Builder
	script.WriteString("set -eu\nexport DEBIAN_FRONTEND=noninteractive\ncd '" + dir + "'\n")
	if len(p.Packages) > 0 {
		pkgs := strings.Join(p.Packages, " ")
		script.WriteString("if ! { apt-get update -qq && apt-get install -y -qq --no-install-recommends " + pkgs +
			"; } >setup.log 2>&1; then echo 'apt-get failed:' >test.log; tail -n 40 setup.log >>test.log; exit 97; fi\n")
	}
	if p.Setup != "" {
		script.WriteString("{\n" + p.Setup + "\n} >>setup.log 2>&1 || { echo 'setup failed:' >test.log; tail -n 40 setup.log >>test.log; exit 98; }\n")
	}
	script.WriteString("./test.bin -test.run '^" + p.Test + "$' -test.v -test.count=1 >test.log 2>&1\n")

	name := Unique("roundhouse-it-priv-")
	id, err := c.CreateContainer(ctx, name, docker.ContainerCreate{
		Image:      self.Config.Image,
		Entrypoint: []string{"bash", "-c", script.String()},
		Env:        []string{PrivilegedEnv + "=1"},
		Labels:     map[string]string{TestLabel: "true"},
		HostConfig: docker.HostConfig{Privileged: true, Binds: []string{dir + ":" + dir}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.RemoveContainer(context.Background(), id) })
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	code, err := c.WaitContainer(ctx, id, "")
	if err != nil {
		t.Fatalf("wait for the privileged container: %v", err)
	}
	out, _ := os.ReadFile(filepath.Join(dir, "test.log"))
	output := string(out)
	switch {
	case code != 0:
		t.Fatalf("privileged %s exited with %d:\n%s", p.Test, code, output)
	case strings.Contains(output, "no tests to run"):
		t.Fatalf("privileged %s did not run:\n%s", p.Test, output)
	case strings.Contains(output, "--- SKIP: "+p.Test):
		t.Skipf("privileged %s skipped:\n%s", p.Test, output)
	}
	return output
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return fmt.Errorf("copy %s: %w", src, err)
	}
	return out.Close()
}
