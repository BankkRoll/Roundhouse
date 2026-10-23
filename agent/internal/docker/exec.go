package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ExecConfig is the body of POST /containers/{id}/exec.
type ExecConfig struct {
	Cmd []string `json:"Cmd"`
	// Env adds KEY=value entries to the container's environment for this
	// process only.
	Env          []string `json:"Env,omitempty"`
	User         string   `json:"User,omitempty"`
	WorkingDir   string   `json:"WorkingDir,omitempty"`
	AttachStdin  bool     `json:"AttachStdin"`
	AttachStdout bool     `json:"AttachStdout"`
	AttachStderr bool     `json:"AttachStderr"`
	Tty          bool     `json:"Tty"`
}

// CreateExec prepares a process to run inside a running container and
// returns the exec ID.
func (c *Client) CreateExec(ctx context.Context, containerID string, cfg ExecConfig) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, request{
		method: http.MethodPost,
		path:   "/containers/" + url.PathEscape(containerID) + "/exec",
		body:   cfg,
	}, &out)
	return out.ID, err
}

// ExecInfo is the subset of GET /exec/{id}/json the agent uses.
type ExecInfo struct {
	ID          string `json:"ID"`
	ContainerID string `json:"ContainerID"`
	Running     bool   `json:"Running"`
	ExitCode    int    `json:"ExitCode"`
	// Pid is the process ID in the host's PID namespace.
	Pid int `json:"Pid"`
}

// InspectExec returns an exec's state.
func (c *Client) InspectExec(ctx context.Context, id string) (ExecInfo, error) {
	var info ExecInfo
	err := c.do(ctx, request{method: http.MethodGet, path: "/exec/" + url.PathEscape(id) + "/json"}, &info)
	return info, err
}

// ExecStream is the hijacked connection of a started exec: writes go to the
// process's stdin (when attached), and [ExecStream.Output] reads its
// multiplexed stdout and stderr.
type ExecStream struct {
	conn net.Conn
	r    *bufio.Reader
	stop func() bool
	once sync.Once
}

// StartExec starts a created exec and hijacks its connection. Cancelling
// ctx closes the connection; the process keeps running until it exits or is
// killed ([Client.KillExec]).
func (c *Client) StartExec(ctx context.Context, execID string) (*ExecStream, error) {
	body, _ := json.Marshal(map[string]bool{"Detach": false, "Tty": false})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/exec/"+url.PathEscape(execID)+"/start", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	dialCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()
	conn, err := c.dial(dialCtx, "tcp", c.hostAddr)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	fail := func(err error) (*ExecStream, error) {
		stop()
		conn.Close()
		return nil, err
	}
	if err := req.Write(conn); err != nil {
		return fail(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return fail(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		err := checkStatus(resp)
		resp.Body.Close()
		if err == nil {
			err = fmt.Errorf("docker: exec start: unexpected HTTP %d", resp.StatusCode)
		}
		return fail(err)
	}
	return &ExecStream{conn: conn, r: br, stop: stop}, nil
}

// Write sends p to the process's stdin.
func (s *ExecStream) Write(p []byte) (int, error) { return s.conn.Write(p) }

// CloseWrite ends the process's stdin, leaving its output readable.
func (s *ExecStream) CloseWrite() error {
	if cw, ok := s.conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return errors.New("docker: connection cannot half-close")
}

// Output copies the process's stdout and stderr into the writers (nil
// discards) until the process ends its output.
func (s *ExecStream) Output(stdout, stderr io.Writer) error {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	d := NewDemuxer(s.r)
	for {
		st, p, err := d.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var w io.Writer
		switch st {
		case Stdout:
			w = stdout
		case Stderr, Systemerr:
			w = stderr
		default:
			continue
		}
		if _, err := w.Write(p); err != nil {
			return err
		}
	}
}

// Close closes the connection.
func (s *ExecStream) Close() error {
	var err error
	s.once.Do(func() {
		s.stop()
		err = s.conn.Close()
	})
	return err
}

// ExecRun is one process [Client.RunExec] runs inside a container.
type ExecRun struct {
	Cmd  []string
	Env  []string
	User string
	// Stdin, when set, is copied to the process's stdin, which is then
	// closed.
	Stdin io.Reader
	// Stdout and Stderr receive the process's output; nil discards it.
	Stdout, Stderr io.Writer
}

// ExecError is a process that ran but exited non-zero.
type ExecError struct {
	ExitCode int
}

// Error implements error.
func (e *ExecError) Error() string { return fmt.Sprintf("exited with code %d", e.ExitCode) }

// execSettle bounds how long an exec may keep reporting Running after its
// output ended.
const execSettle = 10 * time.Second

// RunExec runs a process inside a running container to completion and
// returns its exit code. When ctx ends first, the process is killed
// ([Client.KillExec]) and ctx's error returned. A non-zero exit is not an
// error; callers that need one wrap the code in [ExecError].
func (c *Client) RunExec(ctx context.Context, containerID string, run ExecRun) (int, error) {
	id, err := c.CreateExec(ctx, containerID, ExecConfig{
		Cmd: run.Cmd, Env: run.Env, User: run.User,
		AttachStdin: run.Stdin != nil, AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return -1, fmt.Errorf("exec create: %w", err)
	}
	stream, err := c.StartExec(ctx, id)
	if err != nil {
		c.killAfter(ctx, containerID, id)
		return -1, fmt.Errorf("exec start: %w", err)
	}
	defer stream.Close()
	stdinDone := make(chan error, 1)
	if run.Stdin != nil {
		go func() {
			_, err := io.Copy(stream, run.Stdin)
			if cerr := stream.CloseWrite(); err == nil {
				err = cerr
			}
			stdinDone <- err
		}()
	} else {
		stdinDone <- nil
	}
	outErr := stream.Output(run.Stdout, run.Stderr)
	stream.Close()
	stdinErr := <-stdinDone
	if ctx.Err() != nil {
		c.killAfter(ctx, containerID, id)
		return -1, ctx.Err()
	}
	if outErr != nil {
		c.killAfter(ctx, containerID, id)
		return -1, fmt.Errorf("exec output: %w", outErr)
	}
	code, err := c.execExitCode(ctx, id)
	if err != nil {
		return -1, err
	}
	if code == 0 && stdinErr != nil && !errors.Is(stdinErr, net.ErrClosed) {
		return code, fmt.Errorf("exec stdin: %w", stdinErr)
	}
	return code, nil
}

// execExitCode waits for an exec whose output has ended to finish.
func (c *Client) execExitCode(ctx context.Context, id string) (int, error) {
	deadline := time.Now().Add(execSettle)
	for {
		info, err := c.InspectExec(ctx, id)
		if err != nil {
			return -1, fmt.Errorf("exec inspect: %w", err)
		}
		if !info.Running {
			return info.ExitCode, nil
		}
		if time.Now().After(deadline) {
			return -1, errors.New("exec still running after its output ended")
		}
		t := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			t.Stop()
			return -1, ctx.Err()
		case <-t.C:
		}
	}
}

// killAfter kills an exec that may outlive its caller, on a fresh context.
func (c *Client) killAfter(ctx context.Context, containerID, execID string) {
	kctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, _ = c.KillExec(kctx, containerID, execID)
}

// KillExec kills a running exec's process and reports whether it did.
//
// NOTE: the engine has no API to stop an exec, and one keeps running when
// its client disconnects, so the process is killed by the host PID the
// engine reports. That works only where the agent shares the host's PID
// namespace (a Linux node, not a containerised test run), and only after
// checking that the PID still belongs to the container; elsewhere it
// reports false and the process runs on until it exits.
func (c *Client) KillExec(ctx context.Context, containerID, execID string) (bool, error) {
	info, err := c.InspectExec(ctx, execID)
	if err != nil {
		return false, err
	}
	if !info.Running || info.Pid <= 0 {
		return false, nil
	}
	if info.ContainerID != "" {
		containerID = info.ContainerID
	}
	return killHostProcess(info.Pid, containerID)
}
