package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func muxFrame(st StreamType, p string) []byte {
	hdr := make([]byte, 8)
	hdr[0] = byte(st)
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(p)))
	return append(hdr, p...)
}

// hijackEcho answers an exec start by upgrading the connection, reading
// stdin to its half-close and echoing it upper-cased on stdout, with a line
// on stderr.
func hijackEcho(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "tcp" || r.Header.Get("Connection") != "Upgrade" {
			t.Errorf("exec start without upgrade headers: %v", r.Header)
		}
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = buf.Flush()
		in, err := io.ReadAll(bufio.NewReader(io.MultiReader(buf.Reader, conn)))
		if err != nil {
			t.Error(err)
		}
		_, _ = conn.Write(muxFrame(Stdout, strings.ToUpper(string(in))))
		_, _ = conn.Write(muxFrame(Stderr, "done\n"))
	}
}

func TestRunExecStreamsStdinAndOutput(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /containers/ctr/exec", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, map[string]string{"Id": "ex1"})
	})
	f.handle("POST /exec/ex1/start", hijackEcho(t))
	f.handle("GET /exec/ex1/json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, ExecInfo{ID: "ex1", Running: false, ExitCode: 3})
	})
	var stdout, stderr bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code, err := c.RunExec(ctx, "ctr", ExecRun{
		Cmd: []string{"tr", "a-z", "A-Z"}, Env: []string{"A=1"},
		Stdin: strings.NewReader("hello world"), Stdout: &stdout, Stderr: &stderr,
	})
	if err != nil || code != 3 {
		t.Fatalf("code %d, err %v", code, err)
	}
	if stdout.String() != "HELLO WORLD" || stderr.String() != "done\n" {
		t.Fatalf("stdout %q stderr %q", stdout.String(), stderr.String())
	}
	f.mu.Lock()
	var create ExecConfig
	for i, r := range f.seen {
		if r.URL.Path == "/"+APIVersion+"/containers/ctr/exec" {
			_ = json.Unmarshal([]byte(f.bodies[i]), &create)
		}
	}
	f.mu.Unlock()
	if !create.AttachStdin || !create.AttachStdout || !create.AttachStderr || create.Tty || create.Env[0] != "A=1" {
		t.Fatalf("exec config %+v", create)
	}
}

func TestStartExecReportsEngineErrors(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /exec/gone/start", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 404, map[string]string{"message": "No such exec instance"})
	})
	_, err := c.StartExec(context.Background(), "gone")
	if !IsNotFound(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestRunExecCancelled(t *testing.T) {
	f, c := newFakeEngine(t)
	f.handle("POST /containers/ctr/exec", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, map[string]string{"Id": "ex2"})
	})
	release := make(chan struct{})
	f.handle("POST /exec/ex2/start", func(w http.ResponseWriter, r *http.Request) {
		conn, buf, _ := w.(http.Hijacker).Hijack()
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = buf.Flush()
		<-release
	})
	f.handle("GET /exec/ex2/json", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, ExecInfo{ID: "ex2", Running: true, Pid: 1})
	})
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := c.RunExec(ctx, "ctr", ExecRun{Cmd: []string{"sleep", "100"}})
	if err == nil || ctx.Err() == nil {
		t.Fatalf("err = %v", err)
	}
}
