//go:build unix

package cli

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// watchResize signals on SIGWINCH.
func watchResize(ctx context.Context, _ Terminal) <-chan struct{} {
	out := make(chan struct{}, 1)
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGWINCH)
	go func() {
		defer signal.Stop(sigs)
		for {
			select {
			case <-ctx.Done():
				return
			case <-sigs:
				select {
				case out <- struct{}{}:
				default:
				}
			}
		}
	}()
	return out
}

// prepareOutput has nothing to do: a Unix terminal interprets escape
// sequences already.
func prepareOutput() func() { return func() {} }
