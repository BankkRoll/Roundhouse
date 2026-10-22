package ui

import (
	"fmt"
	"io"
	"sync"
	"time"
)

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// Spinner animates a status line on stderr. It is inert when stderr is not
// a TTY, so callers use it unconditionally.
type Spinner struct {
	u      *IO
	active bool
	mu     sync.Mutex
	msg    string
	stop   chan struct{}
	done   chan struct{}
}

// StartSpinner shows msg with an animation until [Spinner.Stop].
func (u *IO) StartSpinner(msg string) *Spinner {
	s := &Spinner{u: u, msg: msg, active: u.errTTY}
	if !s.active {
		return s
	}
	s.stop, s.done = make(chan struct{}), make(chan struct{})
	go s.run()
	return s
}

func (s *Spinner) run() {
	defer close(s.done)
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for i := 0; ; i++ {
		s.mu.Lock()
		fmt.Fprintf(s.u.Err, "\r\x1b[2K%s %s", s.u.ErrColor().Cyan(spinnerFrames[i%len(spinnerFrames)]), s.msg)
		s.mu.Unlock()
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
	}
}

// Update replaces the spinner's message.
func (s *Spinner) Update(msg string) {
	s.mu.Lock()
	s.msg = msg
	s.mu.Unlock()
}

// Println prints a line to w above the spinner without garbling it.
func (s *Spinner) Println(w io.Writer, line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active {
		fmt.Fprint(s.u.Err, "\r\x1b[2K")
	}
	fmt.Fprintln(w, line)
}

// Stop removes the spinner. It is safe to call more than once.
func (s *Spinner) Stop() {
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return
	}
	s.active = false
	s.mu.Unlock()
	close(s.stop)
	<-s.done
	fmt.Fprint(s.u.Err, "\r\x1b[2K")
}
