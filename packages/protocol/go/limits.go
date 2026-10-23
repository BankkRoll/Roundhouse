package protocol

import (
	"regexp"
	"strconv"
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
	// MaxBuildSecrets is the most BuildKit secrets per build job.
	MaxBuildSecrets = 64
	// MaxBuildSecretValueBytes is the longest single build secret value.
	MaxBuildSecretValueBytes = 32 * 1024
	// MaxSealedBoxCTChars is the longest base64 ciphertext of one sealed box.
	MaxSealedBoxCTChars = 512 * 1024
	// MaxGitRefBytes is the longest git ref a build job may name.
	MaxGitRefBytes = 255
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

// Phase 2–3 limits (ADR 0015), mirroring limits.ts.
const (
	// MaxNextSigningKeys is the most successor keys welcome.next_keys and
	// key_announce carry.
	MaxNextSigningKeys = 2
	// MaxPinnedSigningKeys is the most kids hello.pinned_kids reports.
	MaxPinnedSigningKeys = 3

	// MaxVolumesPerNode is the most volumes one desired_state lists.
	MaxVolumesPerNode = 128
	// MaxMountsPerWorkload is the most mounts per workload (one in Phase 2).
	MaxMountsPerWorkload = 1
	// MinVolumeSizeMB is the smallest volume quota.
	MinVolumeSizeMB = 256
	// MaxVolumeSizeMB is the largest volume quota (1 TiB).
	MaxVolumeSizeMB = 1_048_576
	// MaxMountPathBytes is the longest container mount path.
	MaxMountPathBytes = 1024
	// MaxPublishCIDRs is the most sources a published port admits.
	MaxPublishCIDRs = 64
	// MaxBackupDatabases is the most databases a dump may name.
	MaxBackupDatabases = 64
	// MaxBackupParts is the most parts of one multipart object.
	MaxBackupParts = 10_000
	// MaxBackupJobParts is the most part URLs in backup_job.
	MaxBackupJobParts = 16
	// MaxBackupPartsPerFrame is the most part URLs in one backup_parts.
	MaxBackupPartsPerFrame = 32
	// MaxBackupProgressParts is the most parts one backup_progress reports.
	MaxBackupProgressParts = 256
	// MinBackupPartBytes is R2's multipart minimum.
	MinBackupPartBytes = 5 * 1024 * 1024
	// MaxBackupPartBytes is R2's and S3's 5 GiB part maximum.
	MaxBackupPartBytes = 5 * 1024 * 1024 * 1024
	// BackupPartAlignBytes divides every backup part size.
	BackupPartAlignBytes = 1024 * 1024
	// MaxPresignedURLBytes is the longest presigned URL.
	MaxPresignedURLBytes = 4096
	// MaxBackupTimeoutS is the longest backup or restore (12 h).
	MaxBackupTimeoutS = 43_200
	// MaxDBQueryRows is the most rows a db_query returns.
	MaxDBQueryRows = 1000
	// MaxDBQueryResultBytes bounds a db_query_result's encoded rows.
	MaxDBQueryResultBytes = 458_752
	// MaxDBQueryTimeoutMS is the longest db_query.
	MaxDBQueryTimeoutMS = 30_000
	// MaxDBStatementBytes is the longest raw statement or command document.
	MaxDBStatementBytes = 64 * 1024
	// MaxDBParams is the most SQL parameters or Redis arguments.
	MaxDBParams = 256
	// MaxDBColumns is the most result columns.
	MaxDBColumns = 1024
	// MaxDBIdentifierBytes is the longest database identifier.
	MaxDBIdentifierBytes = 256

	// MaxMeshPeers is the most WireGuard peers of one node.
	MaxMeshPeers = 253
	// MaxMeshAddresses is the most mesh IPs one desired_state.mesh lists.
	MaxMeshAddresses = 4096
	// MaxMeshForwardPairs is the most CIDR pairs one relay forwards.
	MaxMeshForwardPairs = 4096
	// MaxMeshAllowedIPs is the most allowed_ips of one peer.
	MaxMeshAllowedIPs = 256
	// MaxUpstreams is the most upstreams of one route workload.
	MaxUpstreams = 256
	// MaxRegistryPullUsers is the most htpasswd users of a primary registry.
	MaxRegistryPullUsers = 254

	// MinJobTimeoutS is the shortest job_run.timeout_s.
	MinJobTimeoutS = 10
	// MaxJobTimeoutS is the longest job_run.timeout_s (24 h).
	MaxJobTimeoutS = 86_400
	// MaxMetricSamples is the most container samples per metrics frame.
	MaxMetricSamples = 160
	// MinMetricsIntervalMS is the shortest sampling interval.
	MinMetricsIntervalMS = 1000
	// MaxMetricsIntervalMS is the longest sampling interval.
	MaxMetricsIntervalMS = 300_000
	// MaxCertificatesPerNode is the most certificates one manifest lists.
	MaxCertificatesPerNode = 4096
	// MaxCertUpsertsPerFrame is the most bodies in one cert_sync.
	MaxCertUpsertsPerFrame = 32
	// MaxCertIDsPerFrame is the most IDs in cert_sync.removes or cert_ack.
	MaxCertIDsPerFrame = 256
	// MaxCertHostnames is the most hostnames one certificate covers.
	MaxCertHostnames = 100
	// MaxCertPEMBytes is the longest certificate chain.
	MaxCertPEMBytes = 64 * 1024
	// MaxCertKeyPEMBytes is the longest private key.
	MaxCertKeyPEMBytes = 16 * 1024
	// MaxManagedHosts is the most ingress.managed_hosts.
	MaxManagedHosts = 4096
	// MaxIngressSources is the most ingress.allowed_sources.
	MaxIngressSources = 256
	// MaxHSTSMaxAgeS is the longest HSTS max-age (two years).
	MaxHSTSMaxAgeS = 63_072_000
)

// Phase 2–3 formats, mirroring limits.ts.
var (
	wildcardHostnameRE = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	signingKeyIDRE     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	nodeIDRE           = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	requestIDRE        = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	dbNameRE           = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$`)
	dbUserRE           = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$`)
	dbPasswordRE       = regexp.MustCompile(`^[A-Za-z0-9._~-]{16,256}$`)
	ageRecipientRE     = regexp.MustCompile(`^age1[02-9ac-hj-np-z]{58}$`)
	ageIdentityRE      = regexp.MustCompile(`^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$`)
	bcryptRE           = regexp.MustCompile(`^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$`)
	registryUserRE     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	etagRE             = regexp.MustCompile(`^[\x21-\x7e]{1,256}$`)
	presignedURLRE     = regexp.MustCompile(`^https?://[^\s/?#]+/[^\s]*$`)
	mountPathRE        = regexp.MustCompile(`^/[A-Za-z0-9._@%+=:,/-]*$`)
	ipv4RE             = regexp.MustCompile(`^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$`)
	hexGroupRE         = regexp.MustCompile(`^[0-9a-fA-F]{1,4}$`)
	prefixLenRE        = regexp.MustCompile(`^(0|[1-9][0-9]{0,2})$`)
	portTextRE         = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
	hostLabelsRE       = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	sha256HexRE        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	uidGidRE           = regexp.MustCompile(`^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$`)
	scanCursorRE       = regexp.MustCompile(`^[0-9]{1,20}$`)
	registryURLRE      = regexp.MustCompile(`^https?://[^\s/?#]+/?$`)
	httpsURLRE         = regexp.MustCompile(`^https://[^\s/?#]+(/[^\s?#]*)?$`)
	ingressHostRE      = regexp.MustCompile(`^[a-z0-9.-]+$`)
	meshListenRE       = regexp.MustCompile(`^[0-9.]+:5000$`)
)

// ReservedMountPaths are container paths a volume may never cover: kernel
// filesystems and the agent's mount_as_file secrets directory.
var ReservedMountPaths = []string{"/proc", "/sys", "/dev", "/run/secrets"}

// IsSafeMountPath reports whether path is a safe volume mount target:
// absolute, no ".", ".." or empty segment, no trailing "/", not "/", and not
// inside [ReservedMountPaths]. Mirrors isSafeMountPath in TypeScript.
func IsSafeMountPath(path string) bool {
	if len(path) > MaxMountPathBytes || !mountPathRE.MatchString(path) || path == "/" {
		return false
	}
	for _, s := range strings.Split(path[1:], "/") {
		if s == "" || s == "." || s == ".." {
			return false
		}
	}
	for _, r := range ReservedMountPaths {
		if path == r || strings.HasPrefix(path, r+"/") {
			return false
		}
	}
	return true
}

// IsIPv4 reports whether s is a dotted-quad IPv4 address without leading
// zeros. Mirrors isIPv4 in TypeScript.
func IsIPv4(s string) bool { return ipv4RE.MatchString(s) }

// IsIPv6 reports whether s is an IPv6 address in RFC 4291 text form, without
// a zone. It is hand-written rather than net/netip so it agrees exactly
// with the TypeScript isIPv6; fixtures/formats.json pins both.
func IsIPv6(s string) bool {
	if len(s) < 2 || len(s) > 45 {
		return false
	}
	halves := strings.Split(s, "::")
	if len(halves) > 2 {
		return false
	}
	groups := func(part string) []string {
		if part == "" {
			return nil
		}
		return strings.Split(part, ":")
	}
	all := groups(halves[0])
	if len(halves) == 2 {
		all = append(all, groups(halves[1])...)
	}
	count := len(all)
	if count > 0 && strings.Contains(all[count-1], ".") {
		last := all[count-1]
		if !strings.HasSuffix(s, last) || !IsIPv4(last) {
			return false
		}
		all = all[:count-1]
		count++
	}
	for _, g := range all {
		if !hexGroupRE.MatchString(g) {
			return false
		}
	}
	if len(halves) == 2 {
		return count <= 7
	}
	return count == 8
}

// IsCIDR reports whether s is an IPv4 or IPv6 CIDR block. Host bits may be
// set. Mirrors isCidr in TypeScript.
func IsCIDR(s string) bool {
	addr, bits, ok := strings.Cut(s, "/")
	if !ok || !prefixLenRE.MatchString(bits) {
		return false
	}
	n, _ := strconv.Atoi(bits)
	if IsIPv4(addr) {
		return n <= 32
	}
	return IsIPv6(addr) && n <= 128
}

// IsIPv4CIDR reports whether s is an IPv4 CIDR block. Mirrors isIPv4Cidr in
// TypeScript.
func IsIPv4CIDR(s string) bool {
	addr, _, _ := strings.Cut(s, "/")
	return IsCIDR(s) && IsIPv4(addr)
}

func ipv4ToUint(ip string) uint32 {
	var n uint32
	for _, o := range strings.Split(ip, ".") {
		v, _ := strconv.Atoi(o)
		n = n<<8 | uint32(v)
	}
	return n
}

// IPv4InCIDR reports whether ip lies inside the IPv4 block cidr; false when
// either is malformed. Mirrors ipv4InCidr in TypeScript.
func IPv4InCIDR(ip, cidr string) bool {
	if !IsIPv4(ip) || !IsIPv4CIDR(cidr) {
		return false
	}
	base, bits, _ := strings.Cut(cidr, "/")
	n, _ := strconv.Atoi(bits)
	if n == 0 {
		return true
	}
	mask := ^uint32(0) << (32 - n)
	return ipv4ToUint(ip)&mask == ipv4ToUint(base)&mask
}

// IsHostPort reports whether s is "host:port" with a lowercase hostname, an
// IPv4 address or a bracketed IPv6 address, and a port 1–65535 without
// leading zeros. Mirrors isHostPort in TypeScript.
func IsHostPort(s string) bool {
	colon := strings.LastIndex(s, ":")
	if colon <= 0 || len(s) > MaxHostnameLength+6 {
		return false
	}
	host, port := s[:colon], s[colon+1:]
	if !portTextRE.MatchString(port) {
		return false
	}
	if p, _ := strconv.Atoi(port); p > 65535 {
		return false
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return IsIPv6(host[1 : len(host)-1])
	}
	return IsIPv4(host) || hostLabelsRE.MatchString(host)
}

// IsRouteHostname reports whether s is a lowercase hostname, optionally with
// one leading "*." label (ADR 0009). Mirrors isRouteHostname in TypeScript.
func IsRouteHostname(s string) bool {
	return len(s) <= MaxHostnameLength && wildcardHostnameRE.MatchString(s)
}

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
	gitRefRE          = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
	nodeKeyIDRE       = regexp.MustCompile(`^[a-f0-9]{16}$`)
	base64Key32RE     = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)
	base64RE          = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
	privateDomainRE   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.internal$`)
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

// IsSafeGitRef reports whether ref is safe to pass to git fetch: it can't be
// read as an option and follows git check-ref-format (no "..", no "//", no
// component starting with "." or ending in ".lock", no trailing "/" or ".").
// Agents still pass --end-of-options before it. Mirrors isSafeGitRef in
// TypeScript.
func IsSafeGitRef(ref string) bool {
	if len(ref) > MaxGitRefBytes || !gitRefRE.MatchString(ref) {
		return false
	}
	if strings.HasPrefix(ref, "-") || strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") ||
		strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, ".lock") ||
		strings.Contains(ref, "..") || strings.Contains(ref, "//") {
		return false
	}
	for _, c := range strings.Split(ref, "/") {
		if strings.HasPrefix(c, ".") || strings.HasSuffix(c, ".lock") {
			return false
		}
	}
	return true
}

// IsPrivateDomain reports whether s is a private alias of the form
// <service>.<environment>.internal, as the roundhouse.private_domain label
// carries. Agents ignore labels that fail it.
func IsPrivateDomain(s string) bool { return privateDomainRE.MatchString(s) }

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
