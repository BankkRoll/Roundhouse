package builder

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

var (
	idRE        = regexp.MustCompile(`^[a-z]{1,8}_[0-9A-Za-z_]{1,64}$`)
	commitRE    = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)
	cacheKeyRE  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	repoPathRE  = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$`)
	buildArgRE  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	digestRE    = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	maxURLBytes = 2048
)

// validateJob re-checks everything the builder relies on for safety, even
// though the connection layer validates signed frames: the builder must not
// trust its caller to have done so, and tests may relax only the URL scheme.
func validateJob(job *protocol.BuildJob, allowLoopbackHTTP bool) error {
	if !idRE.MatchString(job.BuildID) {
		return userErrorf("invalid build id %q", job.BuildID)
	}
	if err := validateGitURL(job.Source.URL, allowLoopbackHTTP); err != nil {
		return err
	}
	if !commitRE.MatchString(job.Source.CommitSHA) {
		return userErrorf("invalid commit SHA %q: expected a full 40 or 64 character hex SHA", job.Source.CommitSHA)
	}
	switch job.Builder {
	case protocol.BuilderDockerfile:
		if job.DockerfilePath != "" && !protocol.IsSafeRelativePath(job.DockerfilePath) {
			return userErrorf("dockerfile path %q must be a relative path inside the repository", job.DockerfilePath)
		}
	case protocol.BuilderRailpack:
		if job.DockerfilePath != "" {
			return userErrorf("a dockerfile path is only allowed with the Dockerfile builder")
		}
	default:
		return userErrorf("unknown builder %q", job.Builder)
	}
	if !protocol.IsSafeRelativePath(job.ContextDir) {
		return userErrorf("context directory %q must be a relative path inside the repository", job.ContextDir)
	}
	if len(job.BuildArgs) > protocol.MaxBuildArgs {
		return userErrorf("too many build arguments: at most %d", protocol.MaxBuildArgs)
	}
	for k, v := range job.BuildArgs {
		if !buildArgRE.MatchString(k) || len(k) > 256 || len(v) > protocol.MaxBuildArgValueBytes {
			return userErrorf("invalid build argument %q", k)
		}
	}
	if _, err := repositoryPath(job.ImageRepository); err != nil {
		return err
	}
	if !cacheKeyRE.MatchString(job.CacheKey) {
		return userErrorf("invalid cache key %q", job.CacheKey)
	}
	if job.TimeoutS <= 0 {
		return userErrorf("timeout_s must be positive")
	}
	return nil
}

// validateGitURL allows https, and plain http only to a loopback host when
// allowLoopbackHTTP is set. Credentials in the URL are refused: the token
// travels separately so it never lands in .git/config.
func validateGitURL(raw string, allowLoopbackHTTP bool) error {
	if len(raw) > maxURLBytes {
		return userErrorf("repository URL is too long")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return userErrorf("invalid repository URL")
	}
	if u.User != nil {
		return userErrorf("repository URL must not contain credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return userErrorf("repository URL must not have a query or fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !allowLoopbackHTTP || !isLoopbackHost(u.Hostname()) {
			return userErrorf("repository URL must use https://")
		}
	default:
		return userErrorf("repository URL must use https://")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// repositoryPath returns the registry path of a local image repository:
// "127.0.0.1:5000/p/s" becomes "p/s".
func repositoryPath(repo string) (string, error) {
	path, ok := strings.CutPrefix(repo, protocol.RegistryListen+"/")
	if !ok || len(repo) > 512 || !repoPathRE.MatchString(path) {
		return "", userErrorf("image repository %q is not in the local registry", repo)
	}
	return path, nil
}

// cacheRepositoryPath returns the registry path that holds the exported
// BuildKit cache for a cache key. Keys may contain characters repository
// paths cannot, so the key is hashed; jobs sharing a key share the cache.
func cacheRepositoryPath(cacheKey string) string {
	sum := sha256.Sum256([]byte(cacheKey))
	return "roundhouse-cache/" + hex.EncodeToString(sum[:16])
}

// buildTimeout is the job's timeout capped by the node's own limit.
func buildTimeout(job *protocol.BuildJob, limit time.Duration) time.Duration {
	t := time.Duration(job.TimeoutS) * time.Second
	if limit > 0 && limit < t {
		return limit
	}
	return t
}

// errUnsafePath reports a path that resolves outside the checkout.
var errUnsafePath = errors.New("path escapes the repository")

func describePath(rel string) string {
	if rel == "." || rel == "" {
		return "the repository root"
	}
	return fmt.Sprintf("%q", rel)
}
