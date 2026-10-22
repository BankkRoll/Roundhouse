// Package builder turns a [protocol.BuildJob] into an image in the builder
// node's local registry.
//
// Responsibilities:
//   - fetch the repository at exactly the job's commit with the system git
//     binary, keeping any access token out of argv, .git/config and logs;
//   - confine the build context and Dockerfile to the checkout, symlinks
//     included;
//   - run BuildKit as the long-lived rootless container sys_buildkitd and
//     drive it with the BuildKit Go client over `buildctl dial-stdio`, so the
//     daemon never listens on a network socket;
//   - build with the Dockerfile frontend, or plan with `railpack prepare` and
//     build with the pinned Railpack frontend;
//   - push through a per-build, credential-protected registry proxy and read
//     the manifest digest back from the registry;
//   - stream redacted build output as batched logs frames and answer with a
//     [protocol.BuildResult], enforcing the job's timeout.
//
// Only one build runs at a time; a concurrent [Builder.Run] fails fast.
package builder

import (
	"context"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// Builder runs build jobs. Implementations are safe for concurrent use, but
// run one build at a time.
type Builder interface {
	// Run builds job and returns its result, which is always valid for the
	// protocol: OK with the pushed image's digest, or a readable error.
	// emit receives build output as logs frames for job.BuildID, one call at
	// a time from a goroutine Run owns, and never after Run returns; a slow
	// emit slows the build rather than buffering without bound, and nil
	// discards output. Cancelling ctx cancels the build.
	Run(ctx context.Context, job protocol.BuildJob, emit func(protocol.Logs)) protocol.BuildResult
}
