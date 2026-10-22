// Package browser opens URLs in the user's default browser.
package browser

import (
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
)

// Open opens rawURL in the default browser without waiting for it to exit.
//
// SECURITY: only absolute http(s) URLs are passed to the OS opener, so a
// value from the API can never make it launch a local file or another
// protocol handler.
func Open(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("refusing to open %q: not an http(s) URL", rawURL)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String())
	case "darwin":
		cmd = exec.Command("open", u.String())
	default:
		cmd = exec.Command("xdg-open", u.String())
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reap the opener; its exit status says nothing about the browser.
	go func() { _ = cmd.Wait() }()
	return nil
}
