package builder

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	bkclient "github.com/moby/buildkit/client"
	"github.com/moby/buildkit/session"
	"github.com/moby/buildkit/session/secrets/secretsprovider"
	"github.com/opencontainers/go-digest"
	"github.com/tonistiigi/fsutil"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// solveKillGrace is how long a cancelled solve gets to wind down before the
// connection to BuildKit is cut, which aborts it on the daemon's side.
const solveKillGrace = 15 * time.Second

// solveSpec is everything one BuildKit solve needs.
type solveSpec struct {
	frontend string
	attrs    map[string]string
	// mounts maps local source names ("context", "dockerfile") to host
	// directories, sent to the daemon over the session.
	mounts  map[string]string
	secrets map[string][]byte
	// imageRef is name:tag as pushed through the registry proxy.
	imageRef string
	// cacheRef is the registry cache import/export reference.
	cacheRef string
	auth     *sessionAuth
}

// dockerfileSolve builds paths.dockerfile* with the Dockerfile frontend
// built into BuildKit.
//
// SECURITY: a build arg ends up in the image's history (every RUN after its
// ARG records "|N NAME=value"), so args the job marks secret are passed only
// as BuildKit secrets, with their name as the ID, which a Dockerfile reads
// with RUN --mount=type=secret,id=NAME[,env=NAME] and which leave no trace
// in the image.
func dockerfileSolve(job *protocol.BuildJob, paths buildPaths) solveSpec {
	attrs := map[string]string{"filename": paths.dockerfileName}
	secrets := map[string][]byte{}
	for k, v := range job.BuildArgs {
		if job.IsSecretArg(k) {
			secrets[k] = []byte(v)
			continue
		}
		attrs["build-arg:"+k] = v
	}
	return solveSpec{
		frontend: "dockerfile.v0",
		attrs:    attrs,
		mounts:   map[string]string{"context": paths.context, "dockerfile": paths.dockerfileDir},
		secrets:  secrets,
	}
}

// railpackSolve builds a plan prepared by `railpack prepare` with the pinned
// Railpack frontend. Every build arg, secret or not, reaches the build as a
// BuildKit secret, which Railpack exposes to build steps without baking it
// into the image.
func railpackSolve(job *protocol.BuildJob, paths buildPaths, planDir, frontendImage string) solveSpec {
	secrets := make(map[string][]byte, len(job.BuildArgs))
	for k, v := range job.BuildArgs {
		secrets[k] = []byte(v)
	}
	return solveSpec{
		frontend: "gateway.v0",
		attrs: map[string]string{
			"source":                 frontendImage,
			"filename":               railpackPlanFile,
			"build-arg:cache-key":    job.CacheKey,
			"build-arg:secrets-hash": secretsHash(job.BuildArgs),
		},
		mounts:  map[string]string{"context": paths.context, "dockerfile": planDir},
		secrets: secrets,
	}
}

// solve runs spec on c, streaming progress to out, and returns the digest
// of the pushed image manifest.
func solve(ctx context.Context, c *bkclient.Client, spec solveSpec, out *logBatcher) (string, error) {
	mounts := make(map[string]fsutil.FS, len(spec.mounts))
	for name, dir := range spec.mounts {
		fs, err := fsutil.NewFS(dir)
		if err != nil {
			return "", fmt.Errorf("local source %s: %w", name, err)
		}
		mounts[name] = fs
	}
	attachables := []session.Attachable{spec.auth, secretsprovider.FromMap(spec.secrets)}
	opt := bkclient.SolveOpt{
		Frontend:      spec.frontend,
		FrontendAttrs: spec.attrs,
		LocalMounts:   mounts,
		Session:       attachables,
		Exports: []bkclient.ExportEntry{{
			Type: bkclient.ExporterImage,
			Attrs: map[string]string{
				"name": spec.imageRef,
				"push": "true",
			},
		}},
	}
	if spec.cacheRef != "" {
		opt.CacheImports = []bkclient.CacheOptionsEntry{{Type: "registry", Attrs: map[string]string{"ref": spec.cacheRef}}}
		opt.CacheExports = []bkclient.CacheOptionsEntry{{Type: "registry", Attrs: map[string]string{
			"ref":          spec.cacheRef,
			"mode":         "max",
			"ignore-error": "true",
		}}}
	}

	printer := newProgressPrinter(out)
	ch := make(chan *bkclient.SolveStatus, 16)
	printed := make(chan struct{})
	go func() {
		defer close(printed)
		for s := range ch {
			printer.print(s)
		}
	}()

	type outcome struct {
		resp *bkclient.SolveResponse
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		resp, err := c.Solve(ctx, nil, opt, ch)
		done <- outcome{resp, err}
	}()

	var res outcome
	select {
	case res = <-done:
	case <-ctx.Done():
		select {
		case res = <-done:
		case <-time.After(solveKillGrace):
			// Closing the client fails every call on it, so Solve returns
			// and the daemon drops the session and the build with it.
			_ = c.Close()
			res = <-done
		}
	}
	<-printed

	if res.err != nil {
		if ctx.Err() != nil {
			return "", context.Cause(ctx)
		}
		return "", printer.failure(res.err)
	}
	dgst := res.resp.ExporterResponse["containerimage.digest"]
	if _, err := digest.Parse(dgst); err != nil {
		return "", fmt.Errorf("BuildKit returned no image digest (%q)", dgst)
	}
	return dgst, nil
}

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------

// progressPrinter renders BuildKit status updates as plain text lines, in
// the style of `buildctl --progress=plain`: "#N <step>", output lines
// prefixed with the step number, then "#N DONE 1.2s" or "#N ERROR ...".
type progressPrinter struct {
	out *logBatcher

	mu       sync.Mutex
	index    map[digest.Digest]int
	started  map[digest.Digest]bool
	finished map[digest.Digest]bool
	// partial holds each step's unterminated output line, per stream.
	partial map[partialKey]string
	// failedName and failedErr describe the first step that errored, for the
	// result message.
	failedName string
	failedErr  string
}

type partialKey struct {
	vertex digest.Digest
	stream protocol.LogStream
}

func newProgressPrinter(out *logBatcher) *progressPrinter {
	return &progressPrinter{
		out:      out,
		index:    map[digest.Digest]int{},
		started:  map[digest.Digest]bool{},
		finished: map[digest.Digest]bool{},
		partial:  map[partialKey]string{},
	}
}

func (p *progressPrinter) num(d digest.Digest) int {
	n, ok := p.index[d]
	if !ok {
		n = len(p.index) + 1
		p.index[d] = n
	}
	return n
}

// print renders one status update. Within an update, step headers come
// first, then output, then completions, so a step that starts, prints and
// finishes in one update still reads in order.
func (p *progressPrinter) print(s *bkclient.SolveStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, v := range s.Vertexes {
		if (v.Started != nil || v.Cached) && !p.started[v.Digest] {
			p.started[v.Digest] = true
			p.out.add(protocol.StreamStdout, fmt.Sprintf("#%d %s", p.num(v.Digest), v.Name))
		}
	}
	for _, l := range s.Logs {
		p.printLog(l)
	}
	for _, v := range s.Vertexes {
		if p.finished[v.Digest] {
			continue
		}
		switch {
		case v.Error != "" && strings.HasPrefix(v.Name, "importing cache manifest"):
			// The first build for a cache key has nothing to import; BuildKit
			// reports that as a step error but carries on.
			p.finished[v.Digest] = true
			p.out.add(protocol.StreamStdout, fmt.Sprintf("#%d no cache to import yet", p.num(v.Digest)))
		case v.Error != "":
			p.finished[v.Digest] = true
			p.flushPartial(v.Digest)
			if !strings.Contains(v.Error, context.Canceled.Error()) && p.failedErr == "" {
				p.failedName, p.failedErr = v.Name, v.Error
			}
			p.out.add(protocol.StreamStderr, fmt.Sprintf("#%d ERROR: %s", p.num(v.Digest), v.Error))
		case v.Cached && v.Completed != nil:
			p.finished[v.Digest] = true
			p.out.add(protocol.StreamStdout, fmt.Sprintf("#%d CACHED", p.num(v.Digest)))
		case v.Completed != nil && v.Started != nil:
			p.finished[v.Digest] = true
			p.flushPartial(v.Digest)
			p.out.add(protocol.StreamStdout, fmt.Sprintf("#%d DONE %.1fs", p.num(v.Digest), v.Completed.Sub(*v.Started).Seconds()))
		}
	}
	for _, w := range s.Warnings {
		p.out.add(protocol.StreamStderr, fmt.Sprintf("#%d WARN: %s", p.num(w.Vertex), w.Short))
	}
}

func (p *progressPrinter) printLog(l *bkclient.VertexLog) {
	stream := protocol.StreamStdout
	if l.Stream == 2 {
		stream = protocol.StreamStderr
	}
	key := partialKey{l.Vertex, stream}
	lines := strings.Split(strings.ReplaceAll(p.partial[key]+string(l.Data), "\r\n", "\n"), "\n")
	// The last element is an unterminated line, kept for the next chunk
	// unless it has grown past what one log line may hold.
	rest := lines[len(lines)-1]
	lines = lines[:len(lines)-1]
	if len(rest) > protocol.MaxLogLineBytes {
		lines, rest = append(lines, rest), ""
	}
	p.partial[key] = rest
	n := p.num(l.Vertex)
	for _, line := range lines {
		for seg := range strings.SplitSeq(line, "\r") {
			if strings.TrimSpace(seg) != "" {
				p.out.add(stream, fmt.Sprintf("#%d %s", n, seg))
			}
		}
	}
}

func (p *progressPrinter) flushPartial(d digest.Digest) {
	for _, stream := range []protocol.LogStream{protocol.StreamStdout, protocol.StreamStderr} {
		key := partialKey{d, stream}
		if rest := strings.TrimSpace(p.partial[key]); rest != "" {
			p.out.add(stream, fmt.Sprintf("#%d %s", p.num(d), rest))
		}
		delete(p.partial, key)
	}
}

// failure turns a solve error into a message for the user, naming the step
// that failed when there is one.
func (p *progressPrinter) failure(err error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failedErr != "" {
		return &userError{
			msg: fmt.Sprintf("Build step %s failed: %s", strings.TrimSpace(p.failedName), cleanSolveError(p.failedErr)),
			err: err,
		}
	}
	return &userError{msg: "Build failed: " + cleanSolveError(err.Error()), err: err}
}

// cleanSolveError drops the wrapping BuildKit adds around the useful part.
func cleanSolveError(s string) string {
	s = strings.TrimSpace(s)
	for _, prefix := range []string{"failed to solve: ", "rpc error: code = Unknown desc = "} {
		for strings.HasPrefix(s, prefix) {
			s = strings.TrimPrefix(s, prefix)
		}
	}
	return s
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// secretsHash identifies the build args' values so Railpack invalidates the
// layers that read them when a value changes, without the values themselves
// appearing in the build definition.
func secretsHash(args map[string]string) string {
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := digest.SHA256.Digester()
	for _, k := range keys {
		_, _ = io.WriteString(h.Hash(), k+"="+args[k]+"\x00")
	}
	return h.Digest().Encoded()
}
