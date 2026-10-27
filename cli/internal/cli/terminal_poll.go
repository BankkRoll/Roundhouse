//go:build !unix

package cli

import (
	"context"
	"time"
)

// resizePollInterval is how often the window size is compared on systems
// without SIGWINCH.
const resizePollInterval = 250 * time.Millisecond

// watchResize polls the window size.
//
// COMPAT: Windows has no SIGWINCH, and resize events arrive only through
// ReadConsoleInput, which would compete with the stdin reader.
func watchResize(ctx context.Context, t Terminal) <-chan struct{} {
	out := make(chan struct{}, 1)
	go func() {
		cols, rows, _ := t.Size()
		tick := time.NewTicker(resizePollInterval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				c, r, err := t.Size()
				if err != nil || c == cols && r == rows {
					continue
				}
				cols, rows = c, r
				select {
				case out <- struct{}{}:
				default:
				}
			}
		}
	}()
	return out
}
