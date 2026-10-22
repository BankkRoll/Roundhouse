package leaktest

import (
	"strings"
	"testing"
	"time"
)

type recorder struct {
	testing.TB
	cleanups []func()
	errors   []string
}

func (r *recorder) Helper()                      {}
func (r *recorder) Cleanup(f func())             { r.cleanups = append(r.cleanups, f) }
func (r *recorder) Errorf(f string, args ...any) { r.errors = append(r.errors, f) }

func TestCheckDetectsLeak(t *testing.T) {
	defer func(d time.Duration) { Timeout = d }(Timeout)
	Timeout = 200 * time.Millisecond
	r := &recorder{TB: t}
	Check(r)
	stop := make(chan struct{})
	go func() { <-stop }()
	r.cleanups[0]()
	close(stop)
	if len(r.errors) != 1 || !strings.Contains(r.errors[0], "leaked") {
		t.Fatalf("errors = %v", r.errors)
	}
}

func TestCheckPassesWhenGoroutinesExit(t *testing.T) {
	r := &recorder{TB: t}
	Check(r)
	done := make(chan struct{})
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(done)
	}()
	r.cleanups[0]()
	<-done
	if len(r.errors) != 0 {
		t.Fatalf("errors = %v", r.errors)
	}
}
