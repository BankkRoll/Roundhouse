// Command roundhouse is the command-line client for a Roundhouse control
// plane: sign in, link a directory to a project, deploy, follow logs, and
// manage variables, services and servers.
//
// Usage:
//
//	roundhouse login --url https://roundhouse.example.com
//	roundhouse link
//	roundhouse deploy --wait
//	roundhouse logs -f
//
// Run "roundhouse --help" for every command.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/BankkRoll/Roundhouse/cli/internal/cli"
)

// version and commit are set at build time with
// -ldflags "-X main.version=<v> -X main.commit=<sha>".
var (
	version = ""
	commit  = ""
)

func main() {
	// Ctrl-C cancels the command's context instead of killing the process,
	// so watchers can say what keeps running and `run` can report its
	// child's exit status.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Run(ctx, os.Args[1:], cli.SystemEnv(version, commit))
	stop()
	os.Exit(code)
}
