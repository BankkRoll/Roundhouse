package builder

import (
	"os"
	"runtime"
	"strings"
)

// inheritedEnv names the only variables git and Railpack take from the
// agent's own environment (ADR 0014 M1): where binaries and temporary files
// live, and the operator's outbound proxy, without which a builder behind a
// proxy can't reach git hosts or package registries. Everything else they
// run with is set explicitly per build, so nothing else the agent was
// started with (credentials, GIT_* overrides) reaches a build.
var inheritedEnv = []string{
	"PATH", "TMPDIR",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
}

// hostEnv returns the [inheritedEnv] variables that are set, as KEY=value.
func hostEnv() []string {
	names := inheritedEnv
	if runtime.GOOS == "windows" {
		// COMPAT: Windows programs need SYSTEMROOT to load system DLLs;
		// only development agents run there.
		names = append(names[:len(names):len(names)], "SYSTEMROOT")
	}
	var env []string
	for _, k := range names {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// reservedEnvExact are names a build arg or build secret may not take when it
// becomes part of a host process's environment.
var reservedEnvExact = map[string]bool{
	"PATH": true, "HOME": true, "TMPDIR": true, "TMP": true, "TEMP": true,
	"SHELL": true, "ENV": true, "BASH_ENV": true, "IFS": true,
	"GODEBUG": true, "GOTRACEBACK": true, "TERM": true, "NO_COLOR": true,
	"SYSTEMROOT": true, "BUILDKIT_HOST": true,
}

// reservedEnvPrefixes are name prefixes reserved the same way.
var reservedEnvPrefixes = []string{"LD_", "DYLD_", "XDG_", "GIT_", "SSL_CERT_", "MISE_"}

// isReservedEnvName reports whether a user-supplied name would change how a
// host process runs rather than what it builds.
//
// SECURITY: Railpack runs as root on the host with the job's build args and
// secrets in its environment (`--env NAME` reads them from there). Without
// this, a build arg named LD_PRELOAD, PATH or GIT_SSH_COMMAND would steer
// that process, or one it starts, into code from the checked-out repository
// (ADR 0014 M1). Proxy names are reserved in any case because the operator's
// proxy settings come from [inheritedEnv].
func isReservedEnvName(name string) bool {
	upper := strings.ToUpper(name)
	if reservedEnvExact[upper] || strings.HasSuffix(upper, "_PROXY") {
		return true
	}
	for _, p := range reservedEnvPrefixes {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}
