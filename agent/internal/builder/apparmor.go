package builder

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
)

// AppArmorProfile is the AppArmor profile install.sh loads on hosts whose
// kernel lets AppArmor restrict unprivileged user namespaces (Ubuntu 23.10
// and later). sys_buildkitd runs under it when the engine's host has it
// loaded, and unconfined otherwise.
//
// The profile is unconfined in every respect except that it declares
// `userns,`, which is what lets rootlesskit create BuildKit's user namespace
// while kernel.apparmor_restrict_unprivileged_userns=1. It attaches to no
// path, so nothing but a container started with
// `--security-opt apparmor=roundhouse-buildkit` ever runs under it, and the
// host-wide sysctl stays as the distribution set it. The source is
// install/roundhouse-buildkit.apparmor.
const AppArmorProfile = "roundhouse-buildkit"

// AppArmorProfileFile is where install.sh writes [AppArmorProfile], so
// AppArmor reloads it at boot.
const AppArmorProfileFile = "/etc/apparmor.d/roundhouse-buildkit"

const (
	appArmorUnconfined = "unconfined"
	// probeContainerName is the throwaway container that tests whether the
	// engine can start a container under [AppArmorProfile].
	probeContainerName = "sys_buildkitd_apparmor_probe"
)

// Host interfaces read to resolve the profile; variables so tests can point
// them at fixtures.
var (
	// appArmorProfilesPath lists the loaded profiles as "name (mode)" lines.
	// Root can read it without capabilities; it is absent inside containers,
	// where securityfs is not mounted.
	appArmorProfilesPath = "/sys/kernel/security/apparmor/profiles"
	// usernsRestrictSysctl is Ubuntu's switch for the restriction. procfs
	// shows the host kernel's value inside containers too.
	usernsRestrictSysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
)

var appArmorProfileName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// validAppArmorProfile reports whether name is safe to pass to the engine as
// `apparmor=<name>`.
func validAppArmorProfile(name string) bool {
	return appArmorProfileName.MatchString(name)
}

// appArmorProfile returns the AppArmor profile sys_buildkitd runs under,
// resolving it on first use. The caller holds d.mu.
//
// Resolution, first match wins:
//  1. the operator's override ([Options.AppArmorProfile]);
//  2. "unconfined" if the engine does not report AppArmor: the engine
//     ignores profiles there, so asking for one changes nothing;
//  3. the local list of loaded profiles, when this process can read it (a
//     root agent under systemd can);
//  4. otherwise a probe: start a throwaway container under the profile. An
//     agent in a container, as in the end-to-end suite, cannot see the
//     host's securityfs, but the engine applies profiles on its own host,
//     so it is the authority anyway.
func (d *daemon) appArmorProfile(ctx context.Context) (string, error) {
	if d.apparmor != "" {
		return d.apparmor, nil
	}
	profile, reason, err := d.resolveAppArmor(ctx)
	if err != nil {
		return "", err
	}
	if profile != AppArmorProfile && usernsRestricted() {
		d.log.Warn("this host restricts unprivileged user namespaces but the "+AppArmorProfile+
			" AppArmor profile is not loaded; rootless BuildKit cannot start until it is. "+
			"Re-run install.sh on this node, or run `sudo apparmor_parser -r "+AppArmorProfileFile+"`",
			"apparmor_profile", profile, "reason", reason)
	} else {
		d.log.Info("BuildKit AppArmor profile", "apparmor_profile", profile, "reason", reason)
	}
	d.apparmor = profile
	return profile, nil
}

// currentAppArmorProfile returns the profile sys_buildkitd was last created
// under, or "" before the first ensure.
func (d *daemon) currentAppArmorProfile() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.apparmor
}

// forgetAppArmorProfile makes the next build resolve the profile again, so
// one loaded after a failure is picked up without restarting the agent.
func (d *daemon) forgetAppArmorProfile() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.apparmor = ""
}

func (d *daemon) resolveAppArmor(ctx context.Context) (profile, reason string, err error) {
	if d.apparmorOverride != "" {
		return d.apparmorOverride, "set by ROUNDHOUSE_BUILDKIT_APPARMOR_PROFILE", nil
	}
	opts, err := d.docker.securityOptions(ctx)
	if err != nil {
		return "", "", fmt.Errorf("docker info: %w", err)
	}
	if !slices.ContainsFunc(opts, func(o string) bool {
		return o == "name=apparmor" || strings.HasPrefix(o, "name=apparmor,")
	}) {
		return appArmorUnconfined, "the Docker engine does not use AppArmor", nil
	}
	switch loaded, err := profileListed(appArmorProfilesPath, AppArmorProfile); {
	case err == nil && loaded:
		return AppArmorProfile, "loaded on this host", nil
	case err == nil:
		return appArmorUnconfined, AppArmorProfile + " is not loaded on this host", nil
	}
	if err := d.probeAppArmor(ctx, AppArmorProfile); err != nil {
		return appArmorUnconfined, "the engine cannot start a container under " + AppArmorProfile + ": " + err.Error(), nil
	}
	return AppArmorProfile, "the engine starts containers under it", nil
}

// profileListed reports whether name appears in an AppArmor profiles list.
// It fails if the list cannot be read.
func profileListed(path, name string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// Lines look like "roundhouse-buildkit (unconfined)"; names may
		// contain spaces only when quoted, which ours never is.
		if n, _, ok := strings.Cut(sc.Text(), " ("); ok && n == name {
			return true, nil
		}
	}
	return false, sc.Err()
}

// usernsRestricted reports whether the kernel restricts unprivileged user
// namespaces through AppArmor right now.
func usernsRestricted() bool {
	b, err := os.ReadFile(usernsRestrictSysctl)
	return err == nil && strings.TrimSpace(string(b)) == "1"
}

// probeAppArmor starts and removes a no-op container from the BuildKit image
// under profile. Starting fails when the engine's host has no such profile
// loaded, because the runtime cannot switch the container's init into it.
func (d *daemon) probeAppArmor(ctx context.Context, profile string) error {
	if err := d.ensureImage(ctx); err != nil {
		return err
	}
	cleanup := context.WithoutCancel(ctx)
	if err := d.docker.removeContainer(ctx, probeContainerName); err != nil {
		return err
	}
	id, err := d.docker.createContainer(ctx, probeContainerName, map[string]any{
		"Image":      d.image,
		"Entrypoint": []string{"true"},
		"Labels":     map[string]string{labelSystem: "buildkitd-apparmor-probe"},
		"HostConfig": map[string]any{
			"NetworkMode": "none",
			"SecurityOpt": []string{"apparmor=" + profile},
		},
	})
	if err != nil {
		return err
	}
	defer func() { _ = d.docker.removeContainer(cleanup, id) }()
	return d.docker.startContainer(ctx, id)
}

// userNamespaceDenied reports whether sys_buildkitd's output shows
// rootlesskit failing to create its user namespace, which is how AppArmor's
// unprivileged user namespace restriction surfaces.
func userNamespaceDenied(logs string) bool {
	return strings.Contains(logs, "apparmor_restrict_unprivileged_userns") ||
		strings.Contains(logs, "fork/exec /proc/self/exe: permission denied")
}

// userNamespaceHint explains a user namespace denial for the build log and
// says how to fix it.
func userNamespaceHint(profile string) string {
	if profile == AppArmorProfile {
		return "rootless BuildKit could not create its user namespace even under the " + AppArmorProfile +
			" AppArmor profile; check `sudo aa-status` and the kernel log (`journalctl -k | grep apparmor`) for denials"
	}
	return fmt.Sprintf("rootless BuildKit could not create its user namespace: this host restricts unprivileged user "+
		"namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and sys_buildkitd runs with AppArmor profile %q. "+
		"Re-run install.sh on this node to install the %s profile, or load it with `sudo apparmor_parser -r %s`, "+
		"then retry the build", profile, AppArmorProfile, AppArmorProfileFile)
}
