package runtime

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// SecretsMountPath is where a workload's mount_as_file variables appear
// inside its container, one file per variable.
const SecretsMountPath = "/run/secrets"

// DefaultSecretsDir is the host directory holding every workload's secret
// files (ADR 0014, "On the node"). /run is a tmpfs, so they never reach a
// disk and vanish on reboot, when the agent writes them again.
const DefaultSecretsDir = "/run/roundhouse/secrets"

// secretsDir returns the host directory of one workload's secret files.
func (r *Runtime) secretsDir(workloadID string) string {
	return filepath.Join(r.opts.SecretsDir, workloadID)
}

// writeSecretFiles writes s.SecretFiles into the workload's directory and
// returns the bind mount that shows it read-only at [SecretsMountPath], or
// "" when the workload has no secret files.
//
// SECURITY: the root directory is 0700 so no other host user can list or
// read workloads' files; the per-workload directory (0755) and files (0444)
// are readable by any user inside the container, whose image may run as
// any UID. The mount is read-only, and `docker inspect` shows its path only.
// Modes are set explicitly because the agent runs with umask 0077.
func (r *Runtime) writeSecretFiles(s *wantSpec) (string, error) {
	if len(s.SecretFiles) == 0 {
		return "", nil
	}
	if r.opts.SecretsDir == "" {
		return "", errors.New("this agent has no secrets directory for mount_as_file variables")
	}
	if err := os.MkdirAll(r.opts.SecretsDir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(r.opts.SecretsDir, 0o700); err != nil {
		return "", err
	}
	dir := r.secretsDir(s.ID)
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return "", err
	}
	for _, key := range slices.Sorted(maps.Keys(s.SecretFiles)) {
		// NOTE: OpenWorkloadEnv only admits env-var names, which can't
		// name a path; this guards the invariant the paths rely on.
		if key == "" || strings.ContainsAny(key, `/\.`) {
			return "", fmt.Errorf("secret file name %q is not a variable name", key)
		}
		if err := writeReadOnly(filepath.Join(dir, key), []byte(s.SecretFiles[key])); err != nil {
			return "", fmt.Errorf("write secret file %s: %w", key, err)
		}
	}
	return filepath.ToSlash(dir) + ":" + SecretsMountPath + ":ro", nil
}

// writeReadOnly replaces path with a 0444 file holding data, through a temp
// file and a rename so a running container never reads a partial value.
func writeReadOnly(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o444); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// collectSecretDirs removes the secret directories of workloads that are
// neither desired nor backed by one of this runtime's containers, so a
// value lives on the host exactly as long as a container that mounts it.
// Caller holds r.mu.
func (r *Runtime) collectSecretDirs(specs []*wantSpec) {
	if r.opts.SecretsDir == "" {
		return
	}
	entries, err := os.ReadDir(r.opts.SecretsDir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			r.log.Warn("list secret directories", "dir", r.opts.SecretsDir, "err", err)
		}
		return
	}
	keep := map[string]bool{}
	for _, s := range specs {
		keep[s.ID] = true
	}
	for _, inst := range r.instances {
		keep[inst.meta.workloadID] = true
	}
	for _, e := range entries {
		if !e.IsDir() || keep[e.Name()] {
			continue
		}
		if err := os.RemoveAll(filepath.Join(r.opts.SecretsDir, e.Name())); err != nil {
			r.log.Warn("remove secret directory", "workload_id", e.Name(), "err", err)
			continue
		}
		r.log.Info("removed secret files of a removed workload", "workload_id", e.Name())
	}
}
