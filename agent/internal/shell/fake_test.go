package shell

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/runtime"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

const (
	testNode      = "node_1"
	testWorkload  = "wl_web"
	testContainer = "ctr_web"
)

// fakeProc is one exec's process in [fakeEngine]: it echoes its input and
// exits on "exit N\r".
type fakeProc struct {
	id      string
	cfg     docker.ExecConfig
	conn    net.Conn
	running bool
	code    int
	// ignoreHup keeps it running after SIGHUP.
	ignoreHup bool
	signals   []syscall.Signal
	resizes   [][2]int
	started   chan struct{}
}

// fakeEngine is an engine API server for sessions: containers to inspect,
// and execs whose hijacked streams run a [fakeProc].
type fakeEngine struct {
	t      *testing.T
	client *docker.Client

	mu         sync.Mutex
	containers map[string]docker.ContainerInfo
	procs      map[string]*fakeProc
	order      []*fakeProc
	nextID     int
	// banner is written to every process's output when it starts.
	banner []byte
	// ignoreHup makes every new process ignore SIGHUP.
	ignoreHup bool
	// resizeFails makes every resize fail.
	resizeFails bool
}

var execPath = regexp.MustCompile(`^/v[0-9.]+/exec/([^/]+)/(start|resize|json)$`)
var containerPath = regexp.MustCompile(`^/v[0-9.]+/containers/([^/]+)/(json|exec)$`)

func newFakeEngine(t *testing.T) *fakeEngine {
	t.Helper()
	f := &fakeEngine{t: t, containers: map[string]docker.ContainerInfo{}, procs: map[string]*fakeProc{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	c, err := docker.New("tcp://" + strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	f.client = c
	f.addContainer(testContainer, testWorkload, nil)
	return f
}

// addContainer adds a running service workload container of this node, with
// edit applied to it.
func (f *fakeEngine) addContainer(id, workloadID string, edit func(*docker.ContainerInfo)) {
	info := docker.ContainerInfo{
		ID: id, Name: "/" + id,
		State: docker.ContainerState{Status: "running", Running: true},
		Config: docker.ContainerConfig{User: "app", Labels: map[string]string{
			runtime.LabelManaged: "true", runtime.LabelWorkloadID: workloadID,
			runtime.LabelKind: string(protocol.WorkloadService), runtime.LabelNamespace: testNode,
		}},
	}
	if edit != nil {
		edit(&info)
	}
	f.mu.Lock()
	f.containers[id] = info
	f.mu.Unlock()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeEngine) serve(w http.ResponseWriter, r *http.Request) {
	if m := containerPath.FindStringSubmatch(r.URL.Path); m != nil {
		f.mu.Lock()
		info, ok := f.containers[m[1]]
		f.mu.Unlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"message": "No such container"})
			return
		}
		if m[2] == "json" {
			writeJSON(w, 200, info)
			return
		}
		var cfg docker.ExecConfig
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			f.t.Error(err)
		}
		f.mu.Lock()
		f.nextID++
		p := &fakeProc{id: "ex" + strconv.Itoa(f.nextID), cfg: cfg, ignoreHup: f.ignoreHup, started: make(chan struct{})}
		f.procs[p.id] = p
		f.order = append(f.order, p)
		f.mu.Unlock()
		writeJSON(w, 201, map[string]string{"Id": p.id})
		return
	}
	m := execPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		writeJSON(w, 404, map[string]string{"message": "no such route"})
		return
	}
	f.mu.Lock()
	p := f.procs[m[1]]
	f.mu.Unlock()
	if p == nil {
		writeJSON(w, 404, map[string]string{"message": "No such exec instance"})
		return
	}
	switch m[2] {
	case "json":
		f.mu.Lock()
		info := docker.ExecInfo{ID: p.id, ContainerID: testContainer, Running: p.running, ExitCode: p.code, Pid: 4242}
		f.mu.Unlock()
		writeJSON(w, 200, info)
	case "resize":
		rows, _ := strconv.Atoi(r.URL.Query().Get("h"))
		cols, _ := strconv.Atoi(r.URL.Query().Get("w"))
		f.mu.Lock()
		fails := f.resizeFails
		if !fails {
			p.resizes = append(p.resizes, [2]int{rows, cols})
		}
		f.mu.Unlock()
		if fails {
			writeJSON(w, 500, map[string]string{"message": "resize failed"})
			return
		}
		w.WriteHeader(http.StatusCreated)
	case "start":
		// The start options must not reach the process as input.
		_, _ = io.Copy(io.Discard, r.Body)
		f.start(w, p)
	}
}

// start runs p on the hijacked connection until it exits or the client
// hangs up.
func (f *fakeEngine) start(w http.ResponseWriter, p *fakeProc) {
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		f.t.Error(err)
		return
	}
	_, _ = buf.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
	_ = buf.Flush()
	f.mu.Lock()
	p.conn, p.running = conn, true
	banner := f.banner
	f.mu.Unlock()
	close(p.started)
	if len(banner) > 0 {
		_, _ = conn.Write(banner)
	}
	in := bufio.NewReader(io.MultiReader(buf.Reader, conn))
	var line []byte
	chunk := make([]byte, 4096)
	for {
		n, err := in.Read(chunk)
		if n > 0 {
			_, _ = conn.Write(chunk[:n])
			line = append(line, chunk[:n]...)
			for {
				i := bytes.IndexByte(line, '\r')
				if i < 0 {
					break
				}
				cmd := string(line[:i])
				line = line[i+1:]
				if code, ok := strings.CutPrefix(cmd, "exit "); ok {
					c, _ := strconv.Atoi(code)
					f.end(p, c)
					return
				}
			}
		}
		if err != nil {
			// NOTE: like an engine exec, the process outlives its client.
			return
		}
	}
}

// end exits p with code and hangs up its stream.
func (f *fakeEngine) end(p *fakeProc, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !p.running {
		return
	}
	p.running, p.code = false, code
	if p.conn != nil {
		p.conn.Close()
	}
}

func (f *fakeEngine) proc(i int) *fakeProc {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.order) {
		return nil
	}
	return f.order[i]
}

func (f *fakeEngine) execs() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.order)
}

func (f *fakeEngine) signalsOf(p *fakeProc) []syscall.Signal {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]syscall.Signal(nil), p.signals...)
}

func (f *fakeEngine) resizesOf(p *fakeProc) [][2]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]int(nil), p.resizes...)
}

// fakeDocker is the real client against [fakeEngine], with signals, which
// the real client sends by host PID, delivered to the fake process instead.
type fakeDocker struct {
	*docker.Client
	f *fakeEngine
}

func (d fakeDocker) SignalExec(_ context.Context, _, execID string, sig syscall.Signal) (bool, error) {
	f := d.f
	f.mu.Lock()
	p := f.procs[execID]
	if p == nil || !p.running {
		f.mu.Unlock()
		return false, nil
	}
	p.signals = append(p.signals, sig)
	ignore := sig == syscall.SIGHUP && p.ignoreHup
	f.mu.Unlock()
	if !ignore {
		f.end(p, 128+int(sig))
	}
	return true, nil
}

// fakeWorkloads stands in for the runtime's view of the desired state.
type fakeWorkloads map[string]string

func (w fakeWorkloads) ShellContainer(id string) (string, error) {
	if c, ok := w[id]; ok {
		return c, nil
	}
	return "", errors.New("workload " + id + " is not running on this node")
}

// recorder captures the frames a manager sends.
type recorder struct {
	mu     sync.Mutex
	frames []protocol.AgentMessage
	// fail makes Send fail as if the connection were down.
	fail bool
	sig  chan struct{}
}

func newRecorder() *recorder { return &recorder{sig: make(chan struct{}, 1)} }

func (r *recorder) Send(_ context.Context, m protocol.AgentMessage) error {
	if v, ok := m.(protocol.Validator); ok {
		if err := v.Validate(); err != nil {
			panic("invalid frame: " + err.Error())
		}
	}
	r.mu.Lock()
	fail := r.fail
	if !fail {
		r.frames = append(r.frames, m)
	}
	r.mu.Unlock()
	select {
	case r.sig <- struct{}{}:
	default:
	}
	if fail {
		return errors.New("not connected")
	}
	return nil
}

func (r *recorder) snapshot() []protocol.AgentMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]protocol.AgentMessage(nil), r.frames...)
}

func (r *recorder) exits(sessionID string) []*protocol.ExecExit {
	var out []*protocol.ExecExit
	for _, m := range r.snapshot() {
		if e, ok := m.(*protocol.ExecExit); ok && e.SessionID == sessionID {
			out = append(out, e)
		}
	}
	return out
}

func (r *recorder) opened(sessionID string) *protocol.ExecOpened {
	for _, m := range r.snapshot() {
		if o, ok := m.(*protocol.ExecOpened); ok && o.SessionID == sessionID {
			return o
		}
	}
	return nil
}

func (r *recorder) outputs(sessionID string) []*protocol.ExecOutput {
	var out []*protocol.ExecOutput
	for _, m := range r.snapshot() {
		if o, ok := m.(*protocol.ExecOutput); ok && o.SessionID == sessionID {
			out = append(out, o)
		}
	}
	return out
}

func (r *recorder) output(t *testing.T, sessionID string) string {
	var b strings.Builder
	for _, o := range r.outputs(sessionID) {
		p, err := base64.StdEncoding.DecodeString(o.Data)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(p)
	}
	return b.String()
}

// waitFor polls cond until it holds or the test times out.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *recorder) waitExit(t *testing.T, sessionID string) *protocol.ExecExit {
	t.Helper()
	waitFor(t, "exec_exit of "+sessionID, func() bool { return len(r.exits(sessionID)) > 0 })
	return r.exits(sessionID)[0]
}

// harness is a manager wired to a fake engine.
type harness struct {
	m    *Manager
	f    *fakeEngine
	rec  *recorder
	key  *ecdh.PrivateKey
	logs *syncBuffer
	stop context.CancelFunc
	done chan struct{}
}

func newHarness(t *testing.T, edit func(*Options)) *harness {
	t.Helper()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := newFakeEngine(t)
	rec := newRecorder()
	logs := &syncBuffer{}
	opts := Options{
		Docker:    fakeDocker{f.client, f},
		Workloads: fakeWorkloads{testWorkload: testContainer},
		NodeID:    testNode, Key: key, Namespace: testNode,
		Send:   rec.Send,
		Logger: newTestLogger(logs),
		unit:   10 * time.Millisecond, killGrace: 100 * time.Millisecond,
		flushInterval: 5 * time.Millisecond, exitSettle: time.Second,
	}
	if edit != nil {
		edit(&opts)
	}
	h := &harness{m: New(opts), f: f, rec: rec, key: key, logs: logs, done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	h.stop = cancel
	go func() {
		defer close(h.done)
		_ = h.m.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-h.done
	})
	return h
}

func (h *harness) logText() string {
	return h.logs.String()
}

var nextMsg atomic.Int64

func header() protocol.ControlHeader {
	now := time.Now()
	return protocol.ControlHeader{ID: "msg_" + strconv.FormatInt(nextMsg.Add(1), 10), NodeID: testNode, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Minute).UnixMilli()}
}

func openFrame(sessionID, workloadID string) *protocol.ExecOpen {
	return &protocol.ExecOpen{
		Type: protocol.TypeExecOpen, ControlHeader: header(),
		SessionID: sessionID, WorkloadID: workloadID,
		Command: protocol.DefaultExecCommand, TTY: true, Cols: 80, Rows: 24,
		Env:          map[string]string{"TERM": "xterm-256color"},
		IdleTimeoutS: 900, MaxDurationS: 28_800,
	}
}

// input seals data to the harness node.
func (h *harness) input(t *testing.T, sessionID string, seq int64, data string) *protocol.ExecInput {
	t.Helper()
	return sealInput(t, h.key, testNode, sessionID, seq, data)
}

// sealInput seals one input batch as the control plane does.
func sealInput(t *testing.T, key *ecdh.PrivateKey, nodeID, sessionID string, seq int64, data string) *protocol.ExecInput {
	t.Helper()
	plain, _ := json.Marshal(protocol.SealedExecInput{Data: base64.StdEncoding.EncodeToString([]byte(data))})
	box, err := protocol.SealBox(key.PublicKey(), plain, protocol.BoxPurposeExecInput, protocol.ExecInputAAD(nodeID, sessionID, seq))
	if err != nil {
		t.Fatal(err)
	}
	hdr := header()
	hdr.NodeID = nodeID
	return &protocol.ExecInput{Type: protocol.TypeExecInput, ControlHeader: hdr, SessionID: sessionID, Seq: seq, DataSealed: *box}
}

// openWait opens a session and waits for its exec_opened.
func (h *harness) openWait(t *testing.T, f *protocol.ExecOpen) {
	t.Helper()
	h.m.OpenExec(f)
	waitFor(t, "exec_opened of "+f.SessionID, func() bool {
		if e := h.rec.exits(f.SessionID); len(e) > 0 {
			t.Fatalf("session ended: %+v", e[0])
		}
		return h.rec.opened(f.SessionID) != nil
	})
}

// syncBuffer is a log sink tests read while sessions write to it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newTestLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))
}
