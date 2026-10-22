package config

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// LinkDirName is the directory holding the link file.
const LinkDirName = ".roundhouse"

// LinkFileName is the link file inside [LinkDirName].
const LinkFileName = "config.json"

// GitignoreEntry is the line `link` offers to add to .gitignore.
const GitignoreEntry = ".roundhouse/"

// Link binds a directory to a project, environment and optionally a
// service. It holds IDs only, never credentials.
type Link struct {
	// Profile names the credentials profile used when linking.
	Profile string `json:"profile,omitempty"`
	// URL is the control plane origin, so a link made against one control
	// plane is never used against another.
	URL           string `json:"url"`
	WorkspaceID   string `json:"workspace_id"`
	ProjectID     string `json:"project_id"`
	EnvironmentID string `json:"environment_id"`
	ServiceID     string `json:"service_id,omitempty"`
	// Names are cached for display; IDs are authoritative.
	ProjectName     string `json:"project_name,omitempty"`
	EnvironmentName string `json:"environment_name,omitempty"`
	ServiceName     string `json:"service_name,omitempty"`
}

// FindLink looks for a link file in dir and its parents, like git does for
// .git. It returns nil and no error when there is none.
func FindLink(dir string) (*Link, string, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, "", err
	}
	for {
		path := filepath.Join(dir, LinkDirName, LinkFileName)
		data, err := os.ReadFile(path)
		if err == nil {
			var l Link
			if err := json.Unmarshal(data, &l); err != nil {
				return nil, path, fmt.Errorf("parse %s: %w", path, err)
			}
			return &l, path, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, path, err
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, "", nil
		}
		dir = parent
	}
}

// WriteLink writes dir/.roundhouse/config.json.
func WriteLink(dir string, l *Link) (string, error) {
	data, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, LinkDirName, LinkFileName)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	return path, writeAtomic(path, append(data, '\n'), 0o644)
}

// RemoveLink deletes dir/.roundhouse/config.json and the directory if empty.
func RemoveLink(dir string) error {
	path := filepath.Join(dir, LinkDirName, LinkFileName)
	if err := os.Remove(path); err != nil {
		return err
	}
	_ = os.Remove(filepath.Dir(path))
	return nil
}

// GitignorePath returns the .gitignore to update for a link in dir: the one
// at the root of the enclosing git work tree, or dir's own outside git.
func GitignorePath(dir string) string {
	d := dir
	for {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return filepath.Join(d, ".gitignore")
		}
		parent := filepath.Dir(d)
		if parent == d {
			return filepath.Join(dir, ".gitignore")
		}
		d = parent
	}
}

// GitignoreHasEntry reports whether the .gitignore at path already ignores
// the link directory.
func GitignoreHasEntry(path string) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		switch strings.TrimSpace(sc.Text()) {
		case ".roundhouse", ".roundhouse/", "/.roundhouse", "/.roundhouse/", ".roundhouse/*", "**/.roundhouse/":
			return true, nil
		}
	}
	return false, sc.Err()
}

// AppendGitignore adds [GitignoreEntry] to the .gitignore at path, creating
// it if needed and keeping its existing content and line ending intact.
func AppendGitignore(path string) error {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	nl := "\n"
	if bytes.Contains(data, []byte("\r\n")) {
		nl = "\r\n"
	}
	var b bytes.Buffer
	b.Write(data)
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		b.WriteString(nl)
	}
	b.WriteString("# Roundhouse link (project and service IDs)" + nl + GitignoreEntry + nl)
	return os.WriteFile(path, b.Bytes(), 0o644)
}
