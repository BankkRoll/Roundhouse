//go:build !linux

package volumes

import "errors"

// newLoopBackend reports that loop volumes need Linux.
func newLoopBackend(string) (backend, error) {
	return nil, errors.New("loop volumes need Linux")
}
