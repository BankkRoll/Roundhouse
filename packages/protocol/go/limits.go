package protocol

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Size limits, mirroring packages/protocol/src/limits.ts. Byte limits count
// UTF-8 bytes; strings decoded by encoding/json are valid UTF-8, so len()
// matches the TypeScript count.
const (
	// MaxAgentFrameBytes is the largest agent → control frame the control
	// plane accepts, in encoded bytes. Agents split batches to stay below it.
	MaxAgentFrameBytes = 512 * 1024
	// MaxControlFrameBytes is the largest signed control → agent frame.
	MaxControlFrameBytes = 4 * 1024 * 1024
	// CredentialFrameTTLMS is the longest exp - iat of a control frame that
	// carries a credential (git token, registry password, storage keys).
	CredentialFrameTTLMS = 60_000

	// MaxWorkloadsPerNode is the most service workloads one desired_state lists.
	MaxWorkloadsPerNode = 128
	// MaxStatusesPerHello is the most statuses one hello carries, system
	// workloads included.
	MaxStatusesPerHello = 160
	// MaxEnvVars is the most environment variables per workload.
	MaxEnvVars = 256
	// MaxEnvKeyBytes is the longest environment variable name.
	MaxEnvKeyBytes = 256
	// MaxEnvValueBytes is the longest single environment variable value.
	MaxEnvValueBytes = 32 * 1024
	// MaxEnvTotalBytes bounds every env key and value of one workload combined.
	MaxEnvTotalBytes = 64 * 1024
	// MaxLabels is the most labels per workload.
	MaxLabels = 64
	// MaxLabelKeyBytes is the longest label key.
	MaxLabelKeyBytes = 128
	// MaxLabelValueBytes is the longest label value.
	MaxLabelValueBytes = 1024
	// MaxArgs is the most arguments in command or entrypoint.
	MaxArgs = 256
	// MaxArgBytes is the longest single command or entrypoint argument.
	MaxArgBytes = 4096
	// MaxPorts is the most exposed ports per workload.
	MaxPorts = 32
	// MaxRoutes is the most ingress routes per workload.
	MaxRoutes = 32
	// MaxBuildArgs is the most build args per build job.
	MaxBuildArgs = 64
	// MaxBuildArgValueBytes is the longest single build arg value.
	MaxBuildArgValueBytes = 4096
	// MaxHostnameLength is the longest hostname, in characters.
	MaxHostnameLength = 253

	// MaxLogLinesPerFrame is the most lines in one logs frame.
	MaxLogLinesPerFrame = 500
	// MaxLogFrameTextBytes bounds the text of every line in one logs frame combined.
	MaxLogFrameTextBytes = 64 * 1024
	// MaxLogLineBytes is the longest single log line; see [TruncateLogLine].
	MaxLogLineBytes = 16 * 1024
	// MaxMessageBytes is the longest message in a status or build result.
	MaxMessageBytes = 4096

	maxImageReference     = 1024
	maxImageRepository    = 512
	maxRegistryAuthServer = 260
)

// String formats, mirroring the *_RE constants in limits.ts. All are RE2
// compatible, so both sides use the same patterns.
var (
	idRE              = regexp.MustCompile(`^[a-z]{1,8}_[0-9A-Za-z_]{1,64}$`)
	envKeyRE          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	labelKeyRE        = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$`)
	hostnameRE        = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	pathPrefixRE      = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$`)
	networkRE         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	digestRE          = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	specHashRE        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commitSHARE       = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)
	cacheKeyRE        = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	relativePathRE    = regexp.MustCompile(`^[A-Za-z0-9._\-/]{1,512}$`)
	containerIDRE     = regexp.MustCompile(`^[a-f0-9]{12,64}$`)
	registryServerRE  = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]{1,5})?$`)
	s3EndpointRE      = regexp.MustCompile(`^https?://[^\s/?#]+(/[^\s?#]*)?$`)
	bucketRE          = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	regionRE          = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	gitURLRE          = regexp.MustCompile(`^https://[^\s/@?#]+/[^\s?#]+$`)
	imageRepositoryRE = regexp.MustCompile(`^` + repositoryPattern + `$`)
	imageReferenceRE  = regexp.MustCompile(`^` + repositoryPattern + `(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`)
)

const (
	pathComponent     = `[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`
	repositoryPattern = `(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?/)?` + pathComponent + `(?:/` + pathComponent + `)*`
)

// IsSafeRelativePath reports whether path stays inside the repository it is
// resolved against: no leading "/", no ".." segment, no backslashes. "."
// means the root. Mirrors isSafeRelativePath in TypeScript.
func IsSafeRelativePath(path string) bool {
	if !relativePathRE.MatchString(path) || strings.HasPrefix(path, "/") {
		return false
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

// IsHostname reports whether s is a lowercase DNS hostname with at least two
// labels, as routes and apps_domain require.
func IsHostname(s string) bool {
	return len(s) <= MaxHostnameLength && hostnameRE.MatchString(s)
}

// TruncateLogLine shortens text to at most [MaxLogLineBytes] UTF-8 bytes
// without splitting a code point. Invalid UTF-8 from container output is
// replaced with U+FFFD first, since the control plane would reject it.
// Mirrors truncateLogLine in TypeScript.
func TruncateLogLine(text string) string {
	return truncateUTF8(strings.ToValidUTF8(text, "�"), MaxLogLineBytes)
}

func truncateUTF8(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}
