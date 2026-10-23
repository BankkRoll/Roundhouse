package atomicfile

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// renameRetry bounds how long [rename] keeps retrying a replace that a
// concurrent reader blocks.
const renameRetry = 2 * time.Second

// COMPAT: Windows refuses to replace a file another process (or goroutine)
// holds open without FILE_SHARE_DELETE, which os.Open never requests, so a
// plain read racing the rename fails it with ERROR_ACCESS_DENIED or
// ERROR_SHARING_VIOLATION. Readers hold the file only briefly, so the rename
// is retried for a bounded time.
func rename(from, to string) error {
	deadline := time.Now().Add(renameRetry)
	delay := time.Millisecond
	for {
		err := os.Rename(from, to)
		if err == nil || !transient(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(delay*2, 50*time.Millisecond)
	}
}

// errSharingViolation is ERROR_SHARING_VIOLATION, which package syscall does
// not name.
const errSharingViolation syscall.Errno = 32

func transient(err error) bool {
	return errors.Is(err, syscall.ERROR_ACCESS_DENIED) || errors.Is(err, errSharingViolation)
}
