package cli

import (
	"runtime"
	"runtime/debug"
)

// buildInfo describes this binary. When no version was stamped with
// -ldflags, the module version and VCS revision recorded by the Go
// toolchain are used instead.
func buildInfo(version, commit string) versionResult {
	v := versionResult{Version: version, Commit: commit, Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH}
	if info, ok := debug.ReadBuildInfo(); ok {
		if v.Version == "" && info.Main.Version != "" && info.Main.Version != "(devel)" {
			v.Version = info.Main.Version
		}
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && v.Commit == "" && len(s.Value) >= 12 {
				v.Commit = s.Value[:12]
			}
		}
	}
	if v.Version == "" {
		v.Version = "dev"
	}
	return v
}
