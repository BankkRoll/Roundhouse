package builder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// railpackPlanFile is the plan's file name in the plan directory, which
	// the frontend reads as its "dockerfile" source.
	railpackPlanFile = "railpack-plan.json"
	railpackInfoFile = "railpack-info.json"

	// railpackExitTransient is the exit status `railpack prepare` uses for
	// failures worth retrying (EX_TEMPFAIL).
	railpackExitTransient = 75
	railpackAttempts      = 3
	railpackKillGrace     = 5 * time.Second
)

// railpackPlanner runs `railpack prepare` on the host to produce the build
// plan the Railpack frontend consumes.
type railpackPlanner struct {
	bin    string
	home   string
	stdout io.Writer
	stderr io.Writer
}

// prepareArgs are the arguments of `railpack prepare`. Build args are named
// with --env NAME, so Railpack reads their values from its environment and
// they never appear in argv.
func prepareArgs(contextDir, planPath, infoPath string, buildArgs map[string]string) []string {
	args := []string{"prepare", contextDir, "--plan-out", planPath, "--info-out", infoPath}
	keys := make([]string, 0, len(buildArgs))
	for k := range buildArgs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--env", k)
	}
	return args
}

// prepareEnv is Railpack's environment: a fixed minimal base, [hostEnv] and
// the job's build args and secrets, which `--env NAME` reads from here.
func prepareEnv(home string, buildArgs map[string]string) []string {
	env := []string{"HOME=" + home, "XDG_CACHE_HOME=" + filepath.Join(home, ".cache"), "NO_COLOR=1", "TERM=dumb"}
	env = append(env, hostEnv()...)
	for k, v := range buildArgs {
		env = append(env, k+"="+v)
	}
	return env
}

// checkPrepareEnvNames refuses build args and secrets whose names
// [isReservedEnvName] reserves, before any reach Railpack's environment.
func checkPrepareEnvNames(buildArgs map[string]string) error {
	var reserved []string
	for k := range buildArgs {
		if isReservedEnvName(k) {
			reserved = append(reserved, k)
		}
	}
	if len(reserved) == 0 {
		return nil
	}
	sort.Strings(reserved)
	return userErrorf("build arguments %s use reserved names; rename them (Railpack builds can't set PATH, HOME, proxy, LD_*, GIT_* or similar variables)", strings.Join(reserved, ", "))
}

// prepare writes the plan to planDir/railpack-plan.json. A failure to plan
// the app is a [userError] built from Railpack's info file.
func (r *railpackPlanner) prepare(ctx context.Context, contextDir, planDir, contextLabel string, buildArgs map[string]string) error {
	if err := checkPrepareEnvNames(buildArgs); err != nil {
		return err
	}
	if err := os.MkdirAll(planDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(r.home, 0o700); err != nil {
		return err
	}
	planPath := filepath.Join(planDir, railpackPlanFile)
	infoPath := filepath.Join(filepath.Dir(planDir), railpackInfoFile)

	var err error
	for attempt := 1; attempt <= railpackAttempts; attempt++ {
		cmd := exec.CommandContext(ctx, r.bin, prepareArgs(contextDir, planPath, infoPath, buildArgs)...)
		cmd.Env = prepareEnv(r.home, buildArgs)
		cmd.Dir = r.home
		cmd.Stdout = orDiscard(r.stdout)
		cmd.Stderr = orDiscard(r.stderr)
		configureKill(cmd, railpackKillGrace)
		err = cmd.Run()
		if err == nil {
			if _, statErr := os.Stat(planPath); statErr != nil {
				return fmt.Errorf("railpack prepare wrote no plan: %w", statErr)
			}
			return nil
		}
		if ctx.Err() != nil {
			return context.Cause(ctx)
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == railpackExitTransient && attempt < railpackAttempts {
			fmt.Fprintf(orDiscard(r.stderr), "Railpack hit a temporary error; retrying (%d/%d)\n", attempt+1, railpackAttempts)
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return context.Cause(ctx)
			}
			continue
		}
		break
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		return fmt.Errorf("run railpack: %w", err)
	}
	return railpackFailure(infoPath, contextLabel, exit.ExitCode())
}

// railpackInfo is the part of Railpack's --info-out file the builder reads.
type railpackInfo struct {
	Success           bool     `json:"success"`
	DetectedProviders []string `json:"detectedProviders"`
	Logs              []struct {
		Level string `json:"level"`
		Msg   string `json:"msg"`
	} `json:"logs"`
}

// railpackFailure explains a failed `railpack prepare` from its info file.
func railpackFailure(infoPath, contextLabel string, exitCode int) error {
	b, err := os.ReadFile(infoPath)
	var info railpackInfo
	if err != nil || json.Unmarshal(b, &info) != nil {
		if exitCode == railpackExitTransient {
			return userErrorf("Railpack could not prepare the build because of a temporary error; retry the deployment")
		}
		return userErrorf("Railpack could not prepare the build (exit status %d); see the build logs", exitCode)
	}
	var errs []string
	for _, l := range info.Logs {
		if strings.EqualFold(l.Level, "error") && strings.TrimSpace(l.Msg) != "" {
			errs = append(errs, firstLine(l.Msg))
		}
	}
	if len(info.DetectedProviders) == 0 {
		return userErrorf("Railpack could not detect a language or framework in %s. "+
			"Check the service's root directory, or add a Dockerfile and select the Dockerfile builder", contextLabel)
	}
	if len(errs) > 0 {
		return userErrorf("Railpack could not plan the build: %s", strings.Join(errs, "; "))
	}
	return userErrorf("Railpack could not plan the build (exit status %d); see the build logs", exitCode)
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}
