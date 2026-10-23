package builder

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// Defaults for zero [Options] fields.
const (
	// DefaultTimeout is the longest any build may run, the protocol's
	// maximum timeout_s.
	DefaultTimeout = 2 * time.Hour
	// DefaultCacheMaxBytes caps BuildKit's cache at 20 GiB.
	DefaultCacheMaxBytes = 20 << 30
	// DefaultMinFreeBytes is the free disk a build needs to start: 5 GiB.
	DefaultMinFreeBytes = 5 << 30
	// DefaultPruneInterval is how often the cache is trimmed between builds.
	DefaultPruneInterval = time.Hour
)

// Options configures [New].
type Options struct {
	// Logger receives the builder's operational logs (not build output).
	Logger *slog.Logger
	// DataDir is the agent's data directory; checkouts live in
	// DataDir/builds and are removed after every build.
	DataDir string
	// RegistryAddr is the host:port of the local registry that images are
	// pushed to, over plain HTTP. Default [protocol.RegistryListen].
	RegistryAddr string
	// DockerHost is the Docker Engine socket as unix:///path. Default
	// $DOCKER_HOST, else unix:///var/run/docker.sock. BuildKit itself is
	// reached through it, via `buildctl dial-stdio`.
	DockerHost string
	// Timeout caps every build, on top of the job's own timeout_s; the
	// shorter wins. Default [DefaultTimeout].
	Timeout time.Duration

	// GitPath is the git binary. Default: "git" from PATH.
	GitPath string
	// RailpackPath is the railpack binary. Default: "railpack" from PATH.
	// Without it, Railpack builds fail with a clear error.
	RailpackPath string
	// BuildKitImage overrides [BuildKitImage]; for tests.
	BuildKitImage string
	// RailpackFrontendImage overrides [RailpackFrontendImage]; for tests.
	RailpackFrontendImage string

	// CacheMaxBytes caps BuildKit's cache. Default [DefaultCacheMaxBytes].
	CacheMaxBytes int64
	// MinFreeBytes is the free space a build needs to start on DataDir's
	// filesystem, and the space BuildKit's GC keeps free. Default
	// [DefaultMinFreeBytes].
	MinFreeBytes int64
	// PruneInterval is how often the cache is trimmed to CacheMaxBytes
	// between builds. Default [DefaultPruneInterval].
	PruneInterval time.Duration
	// MemoryBytes limits sys_buildkitd's memory; 0 means no limit.
	MemoryBytes int64
	// RegistryProxyPort is where the per-build registry proxy listens on the
	// build network's gateway. Default [DefaultRegistryProxyPort].
	RegistryProxyPort int

	// AllowLoopbackHTTP permits http:// repository URLs whose host is
	// loopback. Tests only: control-plane jobs are always https.
	AllowLoopbackHTTP bool
}

type builder struct {
	opts   Options
	log    *slog.Logger
	daemon *daemon
	http   *http.Client

	// busy admits one build at a time.
	busy sync.Mutex
	// lastPrune is guarded by busy.
	lastPrune time.Time
}

// New returns a Builder. It validates opts but does not touch Docker: the
// BuildKit daemon is started, or repaired, by the first build that needs it.
func New(opts Options) (Builder, error) {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.DataDir == "" {
		return nil, errors.New("builder: DataDir is required")
	}
	if opts.RegistryAddr == "" {
		opts.RegistryAddr = protocol.RegistryListen
	}
	if _, _, err := net.SplitHostPort(opts.RegistryAddr); err != nil {
		return nil, fmt.Errorf("builder: RegistryAddr: %w", err)
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.GitPath == "" {
		opts.GitPath = "git"
	}
	if opts.RailpackPath == "" {
		opts.RailpackPath = "railpack"
	}
	if opts.BuildKitImage == "" {
		opts.BuildKitImage = BuildKitImage
	}
	if opts.RailpackFrontendImage == "" {
		opts.RailpackFrontendImage = RailpackFrontendImage
	}
	if opts.CacheMaxBytes <= 0 {
		opts.CacheMaxBytes = DefaultCacheMaxBytes
	}
	if opts.MinFreeBytes <= 0 {
		opts.MinFreeBytes = DefaultMinFreeBytes
	}
	if opts.PruneInterval <= 0 {
		opts.PruneInterval = DefaultPruneInterval
	}
	if opts.RegistryProxyPort == 0 {
		opts.RegistryProxyPort = DefaultRegistryProxyPort
	}
	if opts.RegistryProxyPort < 1 || opts.RegistryProxyPort > 65535 {
		return nil, fmt.Errorf("builder: RegistryProxyPort %d out of range", opts.RegistryProxyPort)
	}
	docker, err := newDockerAPI(opts.DockerHost)
	if err != nil {
		return nil, fmt.Errorf("builder: %w", err)
	}
	log := opts.Logger.With("component", "builder")
	return &builder{
		opts: opts,
		log:  log,
		daemon: &daemon{
			docker:        docker,
			log:           log,
			image:         opts.BuildKitImage,
			proxyPort:     opts.RegistryProxyPort,
			cacheMaxBytes: opts.CacheMaxBytes,
			minFreeBytes:  opts.MinFreeBytes,
			memoryBytes:   opts.MemoryBytes,
		},
		http: &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}},
	}, nil
}

// Run implements [Builder].
func (b *builder) Run(ctx context.Context, job protocol.BuildJob, emit func(protocol.Logs)) protocol.BuildResult {
	start := time.Now()
	red := newRedactor(job.Source.Token, job.BuildArgs, job.SecretBuildArgs)
	timeout := buildTimeout(&job, b.opts.Timeout)
	if timeout <= 0 {
		timeout = b.opts.Timeout
	}
	ctx, cancel := context.WithTimeoutCause(ctx, timeout, errTimeout)
	defer cancel()

	if !b.busy.TryLock() {
		return buildResult(ctx, &job, nil, errBusy, timeout, time.Since(start), red)
	}
	defer b.busy.Unlock()

	logs := newLogBatcher(job.BuildID, emit, red, nil)
	image, err := b.build(ctx, &job, logs)
	elapsed := time.Since(start)
	res := buildResult(ctx, &job, image, err, timeout, elapsed, red)
	if res.OK {
		logs.system(fmt.Sprintf("Build finished in %s: %s@%s", elapsed.Round(100*time.Millisecond), image.Repository, image.Digest))
		b.log.Info("build succeeded", "build_id", job.BuildID, "digest", image.Digest, "duration", elapsed)
	} else {
		logs.add(protocol.StreamSystem, "Error: "+res.Error)
		b.log.Warn("build failed", "build_id", job.BuildID, "error", red.redact(errString(err)), "duration", elapsed)
	}
	logs.Close()
	return res
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// build runs every stage of one job and returns the pushed image.
func (b *builder) build(ctx context.Context, job *protocol.BuildJob, logs *logBatcher) (*protocol.BuiltImage, error) {
	if err := validateJob(job, b.opts.AllowLoopbackHTTP); err != nil {
		return nil, err
	}
	repoPath, _ := repositoryPath(job.ImageRepository)

	buildsDir := filepath.Join(b.opts.DataDir, "builds")
	if err := os.MkdirAll(buildsDir, 0o700); err != nil {
		return nil, err
	}
	// Builds run one at a time, so anything here was left by an agent that
	// died mid-build.
	if stale, err := os.ReadDir(buildsDir); err == nil {
		for _, e := range stale {
			if err := removeAll(filepath.Join(buildsDir, e.Name())); err != nil {
				b.log.Warn("could not remove stale build directory", "dir", e.Name(), "error", err)
			}
		}
	}
	if err := b.checkDisk(buildsDir); err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp(buildsDir, job.BuildID+"-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := removeAll(work); err != nil {
			b.log.Warn("could not remove build directory", "dir", work, "error", err)
		}
	}()

	// Starting or repairing sys_buildkitd (possibly pulling its image)
	// overlaps with fetching and planning; the result is awaited before the
	// solve, and always before returning.
	ensureCtx, cancelEnsure := context.WithCancel(ctx)
	ensured := make(chan error, 1)
	go func() { ensured <- b.daemon.ensure(ensureCtx) }()
	var ensureErr error
	ensureDone := false
	waitEnsure := func() error {
		if !ensureDone {
			ensureErr, ensureDone = <-ensured, true
		}
		return ensureErr
	}
	defer func() {
		cancelEnsure()
		_ = waitEnsure()
	}()

	src := filepath.Join(work, "src")
	stdout := newLineWriter(logs, protocol.StreamStdout)
	stderr := newLineWriter(logs, protocol.StreamStderr)
	defer stdout.Flush()
	defer stderr.Flush()

	logs.system(fmt.Sprintf("Fetching %s at %s", job.Source.URL, job.Source.CommitSHA))
	git := &gitSource{
		git:       b.opts.GitPath,
		home:      filepath.Join(work, "home"),
		url:       job.Source.URL,
		token:     job.Source.Token,
		allowHTTP: b.opts.AllowLoopbackHTTP,
		stdout:    stdout,
		stderr:    stderr,
	}
	if err := os.MkdirAll(git.home, 0o700); err != nil {
		return nil, err
	}
	if err := git.fetch(ctx, src, job.Source.CommitSHA, job.Source.Ref); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("git is not installed on this builder node: %w", err)
		}
		return nil, err
	}
	stdout.Flush()
	stderr.Flush()

	removed, err := removeEscapingSymlinks(src)
	if err != nil {
		return nil, err
	}
	for _, p := range removed {
		logs.system(fmt.Sprintf("Ignoring symlink %s: it points outside the repository", p))
	}
	paths, err := resolvePaths(src, job)
	if err != nil {
		return nil, err
	}

	var spec solveSpec
	switch job.Builder {
	case protocol.BuilderDockerfile:
		logs.system(fmt.Sprintf("Building %s with Dockerfile %s", describePath(job.ContextDir), paths.dockerfileName))
		if len(job.SecretBuildArgs) > 0 {
			names := slices.Sorted(slices.Values(job.SecretBuildArgs))
			logs.system(fmt.Sprintf("Secret build args %s are BuildKit secrets, not ARGs: read one with "+
				"RUN --mount=type=secret,id=%s,env=%s", strings.Join(names, ", "), names[0], names[0]))
		}
		spec = dockerfileSolve(job, paths)
	case protocol.BuilderRailpack:
		if err := checkRailpackArgs(job.BuildArgs); err != nil {
			return nil, err
		}
		logs.system(fmt.Sprintf("Planning %s with Railpack %s", describePath(job.ContextDir), RailpackVersion))
		planner := &railpackPlanner{bin: b.opts.RailpackPath, home: filepath.Join(work, "railpack-home"), stdout: stdout, stderr: stderr}
		planDir := filepath.Join(work, "plan")
		err := planner.prepare(ctx, paths.context, planDir, describePath(job.ContextDir), job.BuildArgs)
		stdout.Flush()
		stderr.Flush()
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("railpack is not installed on this builder node: %w", err)
		}
		if err != nil {
			return nil, err
		}
		spec = railpackSolve(job, paths, planDir, b.opts.RailpackFrontendImage)
	}

	if err := waitEnsure(); err != nil {
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, fmt.Errorf("BuildKit daemon: %w", err)
	}

	proxy, err := startRegistryProxy(net.JoinHostPort(b.daemon.gatewayIP(), strconv.Itoa(b.opts.RegistryProxyPort)),
		b.opts.RegistryAddr, []string{repoPath, cacheRepositoryPath(job.CacheKey)}, b.log)
	if err != nil {
		return nil, fmt.Errorf("registry proxy: %w", err)
	}
	defer proxy.Close()
	spec.auth = &sessionAuth{host: proxy.authHost(), user: proxy.user, password: proxy.password}
	spec.imageRef = proxy.authHost() + "/" + repoPath + ":" + job.BuildID
	spec.cacheRef = proxy.authHost() + "/" + cacheRepositoryPath(job.CacheKey) + ":buildcache"

	client, err := b.daemon.connect(ctx, slogWriter{b.log})
	if err != nil {
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, fmt.Errorf("connect to BuildKit: %w", err)
	}
	defer client.Close()

	if time.Since(b.lastPrune) > b.opts.PruneInterval {
		pctx, pcancel := context.WithTimeout(ctx, 2*time.Minute)
		if err := b.daemon.prune(pctx, client); err != nil && ctx.Err() == nil {
			b.log.Warn("BuildKit cache prune failed", "error", err)
		}
		pcancel()
		b.lastPrune = time.Now()
	}

	dgst, err := solve(ctx, client, spec, logs)
	if err != nil {
		return nil, err
	}
	pushed, err := manifestDigest(ctx, b.http, b.opts.RegistryAddr, repoPath, job.BuildID)
	if err != nil {
		if ctx.Err() != nil {
			return nil, context.Cause(ctx)
		}
		return nil, fmt.Errorf("verify pushed image: %w", err)
	}
	if pushed != dgst {
		return nil, fmt.Errorf("registry has %s for %s:%s, BuildKit pushed %s", pushed, repoPath, job.BuildID, dgst)
	}
	return &protocol.BuiltImage{Repository: job.ImageRepository, Digest: pushed}, nil
}

// checkDisk refuses to start a build without MinFreeBytes free.
func (b *builder) checkDisk(dir string) error {
	free, err := freeBytes(dir)
	if err != nil {
		b.log.Warn("could not check free disk space", "dir", dir, "error", err)
		return nil
	}
	if free < uint64(b.opts.MinFreeBytes) {
		return userErrorf("the builder node is low on disk space (%d MiB free, %d MiB required); free space on the node and retry",
			free>>20, b.opts.MinFreeBytes>>20)
	}
	return nil
}

// reservedEnv are names Railpack's own process needs; a build arg with one
// of these names would replace the planner's environment.
var reservedEnv = map[string]bool{
	"PATH": true, "HOME": true, "XDG_CACHE_HOME": true, "TMPDIR": true, "SYSTEMROOT": true,
	"NO_COLOR": true, "TERM": true, "HTTPS_PROXY": true, "https_proxy": true, "NO_PROXY": true, "no_proxy": true,
}

func checkRailpackArgs(args map[string]string) error {
	for k := range args {
		if reservedEnv[k] {
			return userErrorf("build argument %s is reserved and cannot be used with Railpack", k)
		}
	}
	return nil
}

// slogWriter logs what `buildctl dial-stdio` prints, which is about the
// connection rather than the build, at debug level.
type slogWriter struct{ log *slog.Logger }

func (w slogWriter) Write(p []byte) (int, error) {
	if s := strings.TrimSpace(string(p)); s != "" {
		w.log.Debug("buildctl dial-stdio", "output", s)
	}
	return len(p), nil
}
