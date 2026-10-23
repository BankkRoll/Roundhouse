package builder

import (
	"errors"
	"maps"
	"slices"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// openSecrets opens the job's build_secrets_sealed. A job without a box has
// no sealed secrets; a box this node can't open fails the build, a box for
// another key with its own message (only a re-join fixes that).
func (b *builder) openSecrets(job *protocol.BuildJob) (map[string]string, error) {
	if job.BuildSecretsSealed == nil {
		return map[string]string{}, nil
	}
	if b.opts.EncryptionKey == nil || b.opts.NodeID == "" {
		return nil, userErrorf("this builder node has no encryption key to open the build's secrets")
	}
	secrets, err := protocol.OpenBuildSecrets(b.opts.EncryptionKey, b.opts.NodeID, job)
	switch {
	case errors.Is(err, protocol.ErrBoxWrongKey):
		return nil, userErrorf("the build's secrets are sealed to an encryption key this node does not hold " +
			"(the node's key changed after it registered); re-join the node with `roundhouse-agent join --force`")
	case err != nil:
		return nil, userErrorf("cannot open the build's secrets: %v", err)
	}
	for k := range secrets {
		if job.IsSecretArg(k) {
			return nil, userErrorf("secret %s is both a secret build arg and a build secret; remove one", k)
		}
	}
	return secrets, nil
}

// buildKitSecrets returns every BuildKit secret of a job, by id: its secret
// build args and its sealed secrets. With Railpack, plain build args are
// passed as secrets too (see [railpackSolve]).
func buildKitSecrets(job *protocol.BuildJob, sealed map[string]string, plainArgsToo bool) map[string][]byte {
	out := make(map[string][]byte, len(job.BuildArgs)+len(sealed))
	for k, v := range job.BuildArgs {
		if plainArgsToo || job.IsSecretArg(k) {
			out[k] = []byte(v)
		}
	}
	for k, v := range sealed {
		out[k] = []byte(v)
	}
	return out
}

// secretNames describes a job's BuildKit secrets for the build log: names
// only, never values.
func secretNames(job *protocol.BuildJob, sealed map[string]string) []string {
	names := slices.Collect(maps.Keys(sealed))
	names = append(names, job.SecretBuildArgs...)
	slices.Sort(names)
	return slices.Compact(names)
}

// secretHint is the build log line telling a Dockerfile how to read the
// job's secrets.
func secretHint(names []string) string {
	return "Build secrets " + strings.Join(names, ", ") + " are BuildKit secrets, not ARGs: read one with " +
		"RUN --mount=type=secret,id=" + names[0] + ",env=" + names[0]
}
