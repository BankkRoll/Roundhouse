// Package leaktest fails a test that leaves goroutines running, using only
// the standard library.
//
// It snapshots the goroutines alive when [Check] is called and, at cleanup,
// waits for every goroutine started since to exit. Goroutines owned by the
// runtime and the testing package are ignored, as are idle HTTP connection
// goroutines, which belong to shared transports rather than to the code
// under test.
package leaktest

import (
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// Timeout is how long cleanup waits for new goroutines to exit. Tests of
// this package shorten it.
var Timeout = 5 * time.Second

// ignored are substrings of stacks that are never leaks of the code under
// test.
var ignored = []string{
	"testing.(*T).Run",
	"testing.(*M).",
	"testing.tRunner",
	"created by runtime.gc",
	"signal.signal_recv",
	"os/signal.loop",
	"net/http.(*persistConn).readLoop",
	"net/http.(*persistConn).writeLoop",
}

// Check registers a cleanup that fails t if goroutines started after this
// call are still running [Timeout] after the test ends. Call it first in a
// test, before anything that starts goroutines; its cleanup then runs after
// every cleanup registered later.
func Check(t testing.TB) {
	t.Helper()
	before := ids(goroutines())
	t.Cleanup(func() {
		deadline := time.Now().Add(Timeout)
		var leaked []string
		for {
			leaked = leaked[:0]
			for _, g := range goroutines() {
				if !slices.Contains(before, id(g)) && !isIgnored(g) {
					leaked = append(leaked, g)
				}
			}
			if len(leaked) == 0 || time.Now().After(deadline) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if len(leaked) > 0 {
			t.Errorf("%d goroutine(s) leaked:\n\n%s", len(leaked), strings.Join(leaked, "\n\n"))
		}
	})
}

func goroutines() []string {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	var out []string
	for _, g := range strings.Split(string(buf), "\n\n") {
		if g = strings.TrimSpace(g); g != "" && !strings.Contains(g, "leaktest.goroutines") {
			out = append(out, g)
		}
	}
	return out
}

// id returns the "goroutine N" prefix of a stack.
func id(stack string) string {
	if i := strings.Index(stack, " ["); i > 0 {
		return stack[:i]
	}
	return stack
}

func ids(stacks []string) []string {
	out := make([]string, len(stacks))
	for i, s := range stacks {
		out[i] = id(s)
	}
	return out
}

func isIgnored(stack string) bool {
	for _, s := range ignored {
		if strings.Contains(stack, s) {
			return true
		}
	}
	return false
}
