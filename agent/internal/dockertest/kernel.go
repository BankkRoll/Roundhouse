package dockertest

import (
	"context"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
)

// MongoKernelIssue is the upstream issue for the MongoDB 8.0+ rseq
// incompatibility.
const MongoKernelIssue = "https://jira.mongodb.org/browse/SERVER-121912"

var kernelRelease = regexp.MustCompile(`^\s*(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?(?:[^\d]|$)`)

// MongoRseqAffected reports whether MongoDB 8.0 and later refuse to start on
// a kernel release: 6.19.0 up to, not including, 7.0.14. It mirrors
// isMongoRseqAffectedKernel in packages/shared/src/kernel.ts, which
// documents the source; only the upstream major.minor.patch prefix counts,
// and an unparsable release counts as unaffected.
func MongoRseqAffected(release string) bool {
	m := kernelRelease.FindStringSubmatch(release)
	if m == nil {
		return false
	}
	v := [3]int{}
	for i, s := range m[1:4] {
		if s != "" {
			v[i], _ = strconv.Atoi(s)
		}
	}
	return !older(v, [3]int{6, 19, 0}) && older(v, [3]int{7, 0, 14})
}

func older(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// HostKernel returns the kernel release of the Docker daemon's host, where
// the test's containers run: Docker's KernelVersion, or this process's own
// kernel when the engine doesn't say (sibling containers share it).
func HostKernel(t testing.TB, c *docker.Client) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if info, err := c.Info(ctx); err == nil && info.KernelVersion != "" {
		return info.KernelVersion
	}
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// SkipIfMongoKernelAffected skips t before it starts a MongoDB 8.0+
// container on a host kernel mongod refuses to start on, which otherwise
// only shows as the container never becoming ready.
func SkipIfMongoKernelAffected(t testing.TB, c *docker.Client) {
	t.Helper()
	if kernel := HostKernel(t, c); MongoRseqAffected(kernel) {
		t.Skipf("MongoDB 8.0+ cannot start on the Docker host's Linux kernel %s (6.19 to 7.0.13); see %s", kernel, MongoKernelIssue)
	}
}
