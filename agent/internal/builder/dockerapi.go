package builder

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// dockerAPIVersion is the Engine API version requests are pinned to. 1.44
// (Engine 25) is the oldest version current engines still serve.
const dockerAPIVersion = "v1.44"

// defaultDockerHost is used when neither Options nor DOCKER_HOST name one.
const defaultDockerHost = "unix:///var/run/docker.sock"

// dockerAPI is the small slice of the Docker Engine API the builder needs to
// manage sys_buildkitd: networks, volumes, images, one container, archive
// upload and a hijacked exec stream. It talks to the engine's unix socket
// only; the engine is never reached over TCP.
//
// It is separate from the runtime's Docker client because the builder needs
// the exec hijack and archive endpoints, and keeping it local lets the two
// evolve independently behind the [Builder] interface.
type dockerAPI struct {
	socket string
	http   *http.Client
}

func newDockerAPI(host string) (*dockerAPI, error) {
	if host == "" {
		host = os.Getenv("DOCKER_HOST")
	}
	if host == "" {
		host = defaultDockerHost
	}
	sock, ok := strings.CutPrefix(host, "unix://")
	if !ok || sock == "" {
		return nil, fmt.Errorf("docker host %q: only unix:// sockets are supported", host)
	}
	d := &dockerAPI{socket: sock}
	d.http = &http.Client{Transport: &http.Transport{
		DialContext:     func(ctx context.Context, _, _ string) (net.Conn, error) { return d.dial(ctx) },
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}}
	return d, nil
}

func (d *dockerAPI) dial(ctx context.Context) (net.Conn, error) {
	var nd net.Dialer
	return nd.DialContext(ctx, "unix", d.socket)
}

// dockerError is a non-2xx answer from the engine.
type dockerError struct {
	status int
	msg    string
}

func (e *dockerError) Error() string { return fmt.Sprintf("docker: %s (HTTP %d)", e.msg, e.status) }

func isNotFound(err error) bool {
	var de *dockerError
	return errors.As(err, &de) && de.status == http.StatusNotFound
}

func isConflict(err error) bool {
	var de *dockerError
	return errors.As(err, &de) && de.status == http.StatusConflict
}

func (d *dockerAPI) newRequest(ctx context.Context, method, path string, q url.Values, body io.Reader, contentType string) (*http.Request, error) {
	u := "http://docker/" + dockerAPIVersion + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req, nil
}

// do sends a request with an optional JSON body and decodes a JSON answer
// into out, if out is non-nil.
func (d *dockerAPI) do(ctx context.Context, method, path string, q url.Values, in, out any) error {
	var body io.Reader
	ct := ""
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body, ct = bytes.NewReader(b), "application/json"
	}
	req, err := d.newRequest(ctx, method, path, q, body, ct)
	if err != nil {
		return err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkDockerStatus(resp); err != nil {
		return err
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out)
}

func checkDockerStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var e struct {
		Message string `json:"message"`
	}
	msg := strings.TrimSpace(string(b))
	if json.Unmarshal(b, &e) == nil && e.Message != "" {
		msg = e.Message
	}
	return &dockerError{status: resp.StatusCode, msg: msg}
}

// securityOptions returns the engine's security features as /info reports
// them, e.g. "name=apparmor" and "name=seccomp,profile=builtin".
func (d *dockerAPI) securityOptions(ctx context.Context) ([]string, error) {
	var info struct {
		SecurityOptions []string `json:"SecurityOptions"`
	}
	err := d.do(ctx, http.MethodGet, "/info", nil, nil, &info)
	return info.SecurityOptions, err
}

// -----------------------------------------------------------------------------
// Networks, volumes, images
// -----------------------------------------------------------------------------

type networkInfo struct {
	ID     string            `json:"Id"`
	Labels map[string]string `json:"Labels"`
	IPAM   struct {
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
		} `json:"Config"`
	} `json:"IPAM"`
}

func (d *dockerAPI) inspectNetwork(ctx context.Context, name string) (networkInfo, error) {
	var n networkInfo
	err := d.do(ctx, http.MethodGet, "/networks/"+url.PathEscape(name), nil, nil, &n)
	return n, err
}

func (d *dockerAPI) createNetwork(ctx context.Context, name string, labels map[string]string) error {
	body := map[string]any{
		"Name":       name,
		"Driver":     "bridge",
		"Attachable": false,
		"Labels":     labels,
		"Options": map[string]string{
			// Only sys_buildkitd joins this network; nothing on it needs to
			// talk to anything else on it.
			"com.docker.network.bridge.enable_icc": "false",
			// A fixed interface name lets host firewalls admit the build's
			// registry traffic; see install/README.md.
			"com.docker.network.bridge.name": BridgeInterface,
		},
	}
	err := d.do(ctx, http.MethodPost, "/networks/create", nil, body, nil)
	if isConflict(err) {
		return nil
	}
	return err
}

func (d *dockerAPI) createVolume(ctx context.Context, name string, labels map[string]string) error {
	return d.do(ctx, http.MethodPost, "/volumes/create", nil, map[string]any{"Name": name, "Labels": labels}, nil)
}

func (d *dockerAPI) imageExists(ctx context.Context, ref string) (bool, error) {
	err := d.do(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, nil)
	if isNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// pullImage pulls ref and fails with the engine's message if the pull
// stream reports an error, which it does with a 200 status.
func (d *dockerAPI) pullImage(ctx context.Context, ref string) error {
	req, err := d.newRequest(ctx, http.MethodPost, "/images/create", url.Values{"fromImage": {ref}}, nil, "")
	if err != nil {
		return err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkDockerStatus(resp); err != nil {
		return err
	}
	dec := json.NewDecoder(resp.Body)
	for {
		var msg struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&msg); err == io.EOF {
			return nil
		} else if err != nil {
			return fmt.Errorf("pull %s: %w", ref, err)
		}
		if msg.Error != "" {
			return fmt.Errorf("pull %s: %s", ref, msg.Error)
		}
	}
}

// -----------------------------------------------------------------------------
// Containers
// -----------------------------------------------------------------------------

type containerInfo struct {
	ID    string `json:"Id"`
	State struct {
		Running    bool   `json:"Running"`
		Restarting bool   `json:"Restarting"`
		Status     string `json:"Status"`
		ExitCode   int    `json:"ExitCode"`
		Error      string `json:"Error"`
	} `json:"State"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

func (d *dockerAPI) inspectContainer(ctx context.Context, name string) (containerInfo, error) {
	var c containerInfo
	err := d.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, nil, &c)
	return c, err
}

func (d *dockerAPI) createContainer(ctx context.Context, name string, spec any) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := d.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, spec, &out)
	return out.ID, err
}

func (d *dockerAPI) startContainer(ctx context.Context, id string) error {
	return d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil, nil)
}

func (d *dockerAPI) removeContainer(ctx context.Context, id string) error {
	err := d.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id), url.Values{"force": {"1"}}, nil, nil)
	if isNotFound(err) {
		return nil
	}
	return err
}

// containerLogs returns the last lines of a container's output, for error
// messages when it fails to start.
func (d *dockerAPI) containerLogs(ctx context.Context, id string, tail int) string {
	req, err := d.newRequest(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/logs",
		url.Values{"stdout": {"1"}, "stderr": {"1"}, "tail": {fmt.Sprint(tail)}}, nil, "")
	if err != nil {
		return ""
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if checkDockerStatus(resp) != nil {
		return ""
	}
	var out bytes.Buffer
	_ = demux(io.LimitReader(resp.Body, 64<<10), &out, &out)
	return out.String()
}

// putArchive extracts a tar stream into path inside a container.
func (d *dockerAPI) putArchive(ctx context.Context, id, path string, tarball []byte) error {
	req, err := d.newRequest(ctx, http.MethodPut, "/containers/"+url.PathEscape(id)+"/archive",
		url.Values{"path": {path}}, bytes.NewReader(tarball), "application/x-tar")
	if err != nil {
		return err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return checkDockerStatus(resp)
}

// -----------------------------------------------------------------------------
// Exec
// -----------------------------------------------------------------------------

// execStdio runs cmd in a container and returns a connection whose reads are
// the command's stdout and whose writes are its stdin. Closing it ends the
// command's stdin and releases the stream. stderr is copied to errOut.
func (d *dockerAPI) execStdio(ctx context.Context, container string, cmd []string, errOut io.Writer) (net.Conn, error) {
	var created struct {
		ID string `json:"Id"`
	}
	err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(container)+"/exec", nil, map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          false,
		"Cmd":          cmd,
	}, &created)
	if err != nil {
		return nil, err
	}

	conn, err := d.dial(ctx)
	if err != nil {
		return nil, err
	}
	// The hijacked stream outlives ctx, which only bounds the handshake.
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()

	body, _ := json.Marshal(map[string]any{"Detach": false, "Tty": false})
	req, err := http.NewRequest(http.MethodPost, "http://docker/"+dockerAPIVersion+"/exec/"+url.PathEscape(created.ID)+"/start", bytes.NewReader(body))
	if err != nil {
		conn.Close()
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		err := checkDockerStatus(resp)
		resp.Body.Close()
		conn.Close()
		if err == nil {
			err = fmt.Errorf("exec start: unexpected HTTP %d", resp.StatusCode)
		}
		return nil, err
	}
	if !stop() {
		conn.Close()
		return nil, ctx.Err()
	}

	pr, pw := io.Pipe()
	ec := &execConn{Conn: conn, r: pr}
	go func() {
		err := demux(br, pw, orDiscard(errOut))
		if err == nil {
			err = io.EOF
		}
		pw.CloseWithError(err)
	}()
	return ec, nil
}

// execConn is a hijacked exec stream: reads come from the demultiplexed
// stdout, writes go to stdin unframed.
type execConn struct {
	net.Conn
	r         *io.PipeReader
	closeOnce sync.Once
}

func (c *execConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (c *execConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.Conn.Close()
		_ = c.r.Close()
	})
	return err
}

// demux splits Docker's multiplexed attach stream (8-byte headers carrying
// the stream number and frame length) into stdout and stderr.
func demux(r io.Reader, stdout, stderr io.Writer) error {
	var hdr [8]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		n := int64(binary.BigEndian.Uint32(hdr[4:]))
		var w io.Writer
		switch hdr[0] {
		case 1:
			w = stdout
		case 2:
			w = stderr
		default:
			w = io.Discard
		}
		if _, err := io.CopyN(w, r, n); err != nil {
			return err
		}
	}
}
