package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"

	"github.com/BankkRoll/Open-Rail/agent/internal/docker"
	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// RegistryWorkloadID is the ID of the builder node's registry.
const RegistryWorkloadID = "sys_registry"

// SystemNetwork is the bridge network system workloads join.
const SystemNetwork = "openrail-system"

// RegistryImage is the CNCF distribution registry the builder node runs.
//
// It is pinned by the digest of the multi-arch index, so every node runs
// byte-identical code whatever the tag later points to, and a compromised
// or re-pushed tag cannot change what runs next to the build cache.
// Bumping it is a deliberate change: update both the tag and the digest
// (docker buildx imagetools inspect registry:<version>).
const RegistryImage = "registry:3.1.2@sha256:01cd312e67026f06f5d89c3e133a4a9adc7cb9eeb9b1194e0b2954dfd770efd2"

const registryPort = 5000

// registrySpec derives the registry system workload from the desired
// state's registry config. Secrets (S3 keys) travel only in the container's
// environment, never in a file the agent writes.
func registrySpec(cfg *protocol.RegistryConfig, dataDir string, generation int64) *wantSpec {
	env := map[string]string{
		"REGISTRY_HTTP_ADDR":              ":5000",
		"REGISTRY_LOG_LEVEL":              "info",
		"REGISTRY_STORAGE_DELETE_ENABLED": "true",
		"OTEL_TRACES_EXPORTER":            "none",
	}
	var binds []string
	if cfg.Storage.Type == protocol.StorageS3 {
		s := cfg.Storage
		env["REGISTRY_STORAGE"] = "s3"
		env["REGISTRY_STORAGE_S3_REGIONENDPOINT"] = s.Endpoint
		env["REGISTRY_STORAGE_S3_BUCKET"] = s.Bucket
		env["REGISTRY_STORAGE_S3_REGION"] = s.Region
		env["REGISTRY_STORAGE_S3_ACCESSKEY"] = s.AccessKeyID
		env["REGISTRY_STORAGE_S3_SECRETKEY"] = s.SecretAccessKey
		env["REGISTRY_STORAGE_S3_FORCEPATHSTYLE"] = "true"
	} else {
		binds = []string{filepath.ToSlash(filepath.Join(dataDir, "registry")) + ":/var/lib/registry"}
	}
	s := &wantSpec{
		WorkloadSpec: protocol.WorkloadSpec{
			ID:    RegistryWorkloadID,
			Kind:  protocol.WorkloadSystem,
			Image: RegistryImage,
			Env:   env,
			Ports: []protocol.WorkloadPort{{ContainerPort: registryPort, Protocol: protocol.PortHTTP}},
			Healthcheck: &protocol.Healthcheck{
				Type: protocol.HealthcheckHTTP, Path: "/v2/", Port: registryPort,
				IntervalS: 5, TimeoutS: 3, Retries: 3, StartPeriodS: 10,
			},
			Resources: protocol.Resources{CPUMillis: 1000, MemoryMB: 512, PIDs: 1024},
			Restart:   protocol.Restart{Policy: protocol.RestartAlways},
			Network:   SystemNetwork,
			Labels:    map[string]string{},
		},
		generation: generation,
		hostPorts: map[string][]docker.PortBinding{
			"5000/tcp": {{HostIP: "127.0.0.1", HostPort: "5000"}},
		},
		binds:     binds,
		exclusive: true,
	}
	s.SpecHash = systemHash(s)
	return s
}

// systemHash covers the spec and the host-level extras a [WorkloadSpec]
// cannot express, so a change to either recreates the container.
func systemHash(s *wantSpec) string {
	base, err := protocol.ComputeSpecHash(s.WorkloadSpec)
	if err != nil {
		// NOTE: only non-integer numbers fail canonicalisation, and system
		// specs contain none.
		panic("runtime: system spec hash: " + err.Error())
	}
	extras, _ := json.Marshal(struct {
		Ports map[string][]docker.PortBinding
		Binds []string
	}{s.hostPorts, s.binds})
	sum := sha256.Sum256(append([]byte(base+"\n"), extras...))
	return hex.EncodeToString(sum[:])
}
