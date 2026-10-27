//go:build integration

package mesh_test

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/config"
	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/dockertest"
	"github.com/BankkRoll/Roundhouse/agent/internal/ingress"
	"github.com/BankkRoll/Roundhouse/agent/internal/nodekey"
	"github.com/BankkRoll/Roundhouse/agent/internal/sealtest"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
	"github.com/coder/websocket"
	"golang.org/x/crypto/bcrypt"
)

// dindImage runs each test node: its own Docker engine, kernel network
// namespace and netfilter, as a separate host would have.
const dindImage = "docker:29-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977"

// workloadImage is busybox, loaded into each node under a local tag so the
// nodes never pull it.
const workloadImage = "rh-it/busybox:mesh"

// webScript serves on 80 (routed) and 8080 (not routed) from one container.
const webScript = "mkdir -p /www && echo hello-from-web >/www/index.html && httpd -p 8080 -h /www && exec httpd -f -p 80 -h /www"

const (
	project   = "prj_mesh"
	envA      = "env_prod"
	envB      = "env_stage"
	envATag   = 11
	envBTag   = 12
	webIP     = "10.200.1.10"
	clientIP  = "10.200.2.10"
	intruder  = "10.200.2.11"
	webDomain = "web.production.proj.internal"
	routeHost = "web.example.test"
	// pullUser pulls from node 1's mesh registry listener as node 2.
	pullUser = "node_mesh2"
	// pushedRepo is the repository pushed to node 1 and pulled on node 2.
	pushedRepo = "127.0.0.1:5000/" + project + "/svc_web"
)

// ingressSources is node 1's allowed_sources: neither node is in it.
var ingressSources = []string{"198.51.100.0/24", "2001:db8::/32"}

// TestMeshTwoNodes runs the real agent on two Docker-in-Docker nodes, one
// with kernel WireGuard and one with wireguard-go, against a fake control
// plane, and checks ADR 0005's guarantees end to end: the mesh comes up
// with a handshake; a replica of environment A on node 2 resolves and
// reaches A's replica on node 1 by private name over the mesh; environment
// B on node 2 gets NXDOMAIN for that name and cannot reach its mesh IP; and
// node 1 admits node 2's ingress source only to the routed port.
func TestMeshTwoNodes(t *testing.T) {
	c := dockertest.Client(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()

	bin := buildAgent(t)
	dockertest.Pull(t, c, dindImage)
	dockertest.Pull(t, c, dockertest.BusyboxImage)
	busybox, err := c.InspectImage(ctx, dockertest.BusyboxImage)
	if err != nil {
		t.Fatal(err)
	}

	network := dockertest.Unique("rh-it-mesh-")
	dockertest.Network(t, c, network, nil)
	dockertest.Attach(t, c, network)
	selfIP := dockertest.IP(t, c, dockertest.Self(t, c), network)

	cp := newFakeCP(t, selfIP)
	nodes := []*node{
		{nodeID: "node_mesh1", index: 1, mode: "kernel"},
		{nodeID: "node_mesh2", index: 2, mode: "userspace"},
	}
	var wg sync.WaitGroup
	errs := make([]error, len(nodes))
	for i, n := range nodes {
		n.start(t, c, network)
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = n.provision(ctx, c, bin, busybox.ID, cp)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("provision %s: %v", nodes[i].nodeID, err)
		}
	}
	t.Cleanup(func() {
		if t.Failed() {
			for _, n := range nodes {
				n.dump(t, c)
			}
		}
	})
	for _, n := range nodes {
		n.runAgent(t, c)
	}

	hellos := cp.waitHellos(t, 90*time.Second, nodes)
	for _, n := range nodes {
		h := hellos[n.nodeID]
		if h.Mesh == nil || h.Mesh.NAT != "public" || h.Mesh.DockerFirewall != "iptables" || !h.Mesh.AcceptFwmark {
			t.Fatalf("%s hello.mesh = %+v", n.nodeID, h.Mesh)
		}
		n.pub = h.Mesh.PublicKey
	}
	cp.plan(nodes)
	for _, n := range nodes {
		cp.send(n.nodeID)
	}

	// 1. Both nodes report ready.
	for _, n := range nodes {
		cp.waitStatus(t, n.nodeID, 90*time.Second, "ready", func(s protocol.MeshStatus) bool { return s.Ready })
	}
	node1, node2 := nodes[0], nodes[1]
	for _, n := range nodes {
		if out, code := n.sh(t, c, "ip -br link show wg0; ip -br addr show rh-dns0"); code != 0 {
			t.Fatalf("%s interfaces: %s", n.nodeID, out)
		}
	}
	if out, _ := node2.sh(t, c, "ip -d link show wg0"); strings.Contains(out, "wireguard") {
		t.Errorf("node 2 should run userspace WireGuard (a tun device), got:\n%s", out)
	}

	waitContainer(t, c, node1, "wl_web")
	waitContainer(t, c, node2, "wl_client")
	waitContainer(t, c, node2, "wl_intruder")

	// 2. Same environment across nodes: name and HTTP over the mesh.
	eventually(t, 90*time.Second, "env A on node 2 to resolve "+webDomain+" to the mesh IP", func() (bool, string) {
		out, code := node2.inContainer(t, c, "wl_client", "nslookup "+webDomain)
		return code == 0 && strings.Contains(out, webIP), out
	})
	eventually(t, 60*time.Second, "env A on node 2 to reach web by name", func() (bool, string) {
		out, code := node2.inContainer(t, c, "wl_client", "wget -q -T 5 -O- http://"+webDomain+"/")
		return code == 0 && strings.Contains(out, "hello-from-web"), out
	})
	// Any port within the environment, not only routed ones.
	if out, code := node2.inContainer(t, c, "wl_client", "wget -q -T 5 -O- http://"+webIP+":8080/"); code != 0 || !strings.Contains(out, "hello-from-web") {
		t.Errorf("env A to web:8080 over the mesh: %d %s", code, out)
	}
	// The Phase 1 three-label name answers the same way.
	if out, code := node2.inContainer(t, c, "wl_client", "nslookup web.production.internal"); code != 0 || !strings.Contains(out, webIP) {
		t.Errorf("three-label name: %d %s", code, out)
	}
	// Names outside the mesh still resolve, forwarded to the host's resolver.
	if out, code := node2.inContainer(t, c, "wl_client", "nslookup docker.com"); code != 0 {
		t.Errorf("public name through private DNS: %d %s", code, out)
	}

	// 3. Another environment: no name, no route.
	out, _ := node2.inContainer(t, c, "wl_intruder", "nslookup "+webDomain)
	if !strings.Contains(out, "NXDOMAIN") {
		t.Errorf("env B resolving %s: want NXDOMAIN, got:\n%s", webDomain, out)
	}
	if out, code := node2.inContainer(t, c, "wl_intruder", "wget -q -T 4 -O- http://"+webIP+"/"); code == 0 || strings.Contains(out, "hello-from-web") {
		t.Errorf("env B reached env A's mesh IP: %s", out)
	}
	if out, code := node2.inContainer(t, c, "wl_intruder", "wget -q -T 4 -O- http://"+clientIP+":80/"); code == 0 {
		t.Errorf("env B reached env A's local mesh IP: %s", out)
	}

	// 4. Ingress source: node 2's .1 reaches the routed port only.
	if out, code := node2.sh(t, c, "wget -q -T 5 -O- http://"+webIP+":80/"); code != 0 || !strings.Contains(out, "hello-from-web") {
		t.Errorf("node 2 ingress to the routed port: %d %s", code, out)
	}
	if out, code := node2.sh(t, c, "wget -q -T 4 -O- http://"+webIP+":8080/"); code == 0 {
		t.Errorf("node 2 ingress reached an unrouted port: %s", out)
	}
	// The route workload's upstream is served by node 2's upstream DNS.
	name := ingress.UpstreamName(routeHost, "", 80)
	eventually(t, 30*time.Second, "node 2's upstream DNS to answer the route workload", func() (bool, string) {
		out, code := node2.sh(t, c, "dig +short @127.0.0.1 -p 2021 "+name)
		return code == 0 && strings.TrimSpace(out) == webIP, out
	})

	// 5. Registry over the mesh: an image pushed to node 1's primary is
	// pulled by digest on node 2 through its proxy, and node 1's listener
	// wants credentials and is out of the containers' reach.
	waitContainer(t, c, node1, "sys_registry")
	waitContainer(t, c, node1, "sys_registry_mesh")
	waitContainer(t, c, node2, "sys_registry")
	var digest string
	eventually(t, 90*time.Second, "a push to node 1's registry", func() (bool, string) {
		out, code := node1.sh(t, c, "docker tag "+workloadImage+" "+pushedRepo+":it && docker push "+pushedRepo+":it")
		digest = pushedDigest(out)
		return code == 0 && digest != "", out
	})
	eventually(t, 90*time.Second, "node 2 to pull "+digest+" through its proxy", func() (bool, string) {
		out, code := node2.sh(t, c, "docker pull "+pushedRepo+"@"+digest)
		return code == 0, out
	})
	if out, code := node2.sh(t, c, "docker image inspect --format '{{.Id}}' "+pushedRepo+"@"+digest); code != 0 {
		t.Errorf("pulled image missing on node 2: %s", out)
	}
	registry := "http://" + node1.meshAddr() + ":5000/v2/"
	if out, _ := node2.sh(t, c, "wget -S -T 5 -O- "+registry+" 2>&1"); !strings.Contains(out, "401") {
		t.Errorf("unauthenticated pull from node 2's host was not refused with 401:\n%s", out)
	}
	authed := "http://" + pullUser + ":" + cp.pullPassword + "@" + node1.meshAddr() + ":5000/v2/"
	if out, code := node2.sh(t, c, "wget -q -T 5 -O- "+authed); code != 0 {
		t.Errorf("node 2 with its pull credentials: %d %s", code, out)
	}
	if out, _ := node2.sh(t, c, "wget -q -T 5 --post-data= -O- "+strings.TrimSuffix(authed, "/v2/")+"/v2/"+project+"/svc_web/blobs/uploads/ 2>&1"); !strings.Contains(out, "405") {
		t.Errorf("the mesh listener accepted an upload:\n%s", out)
	}
	for _, w := range []string{"wl_client", "wl_intruder"} {
		if out, code := node2.inContainer(t, c, w, "wget -T 4 -O- "+registry+" 2>&1"); code == 0 || strings.Contains(out, "401") {
			t.Errorf("%s reached node 1's registry listener: %s", w, out)
		}
	}

	// 6. Ingress filter: with allowed_sources, node 1 admits 80 and 443 only
	// from them (and loopback); other ports are untouched; without, all.
	if out, code := node1.sh(t, c, "mkdir -p /tmp/www && echo ingress-ok >/tmp/www/index.html && httpd -p 80 -h /tmp/www && httpd -p 8081 -h /tmp/www"); code != 0 {
		t.Fatalf("start httpd on node 1: %s", out)
	}
	node1Web := "http://" + node1.ip
	if out, code := node2.sh(t, c, "wget -q -T 5 -O- "+node1Web+"/"); code != 0 || !strings.Contains(out, "ingress-ok") {
		t.Fatalf("node 1:80 before the filter: %d %s", code, out)
	}
	cp.mu.Lock()
	cp.filtered = true
	cp.mu.Unlock()
	cp.send(node1.nodeID)
	eventually(t, 30*time.Second, "node 1's ingress filter", func() (bool, string) {
		out, code := node1.sh(t, c, "nft list chain inet roundhouse ingress_filter")
		return code == 0, out
	})
	if out, code := node2.sh(t, c, "wget -q -T 4 -O- "+node1Web+"/"); code == 0 {
		t.Errorf("node 2 reached node 1:80 from outside the allowed sources: %s", out)
	}
	if out, code := node2.sh(t, c, "wget -q -T 5 -O- "+node1Web+":8081/"); code != 0 {
		t.Errorf("the filter closed another port: %d %s", code, out)
	}
	if out, code := node1.sh(t, c, "wget -q -T 5 -O- http://127.0.0.1/"); code != 0 {
		t.Errorf("loopback to 80 under the filter: %d %s", code, out)
	}
	// The mesh still works under the filter.
	if out, code := node2.inContainer(t, c, "wl_client", "wget -q -T 5 -O- http://"+webDomain+"/"); code != 0 {
		t.Errorf("env A over the mesh under the filter: %d %s", code, out)
	}
	cp.mu.Lock()
	cp.filtered = false
	cp.mu.Unlock()
	cp.send(node1.nodeID)
	eventually(t, 30*time.Second, "node 1's ingress filter to go", func() (bool, string) {
		out, code := node2.sh(t, c, "wget -q -T 3 -O- "+node1Web+"/")
		return code == 0 && strings.Contains(out, "ingress-ok"), out
	})
	if out, code := node1.sh(t, c, "nft list chain inet roundhouse ingress_filter"); code == 0 {
		t.Errorf("ingress_filter left behind:\n%s", out)
	}

	// 7. Every golden table of netpol passes nft's check on a real kernel.
	goldens, err := filepath.Glob(filepath.Join("..", "netpol", "testdata", "*.nft"))
	if err != nil || len(goldens) == 0 {
		t.Fatalf("golden tables: %v %v", goldens, err)
	}
	for _, g := range goldens {
		script, err := os.ReadFile(g)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		code, err := c.RunExec(ctx, node1.id, docker.ExecRun{Cmd: []string{"nft", "-c", "-f", "-"}, Stdin: bytes.NewReader(script), Stdout: &out, Stderr: &out})
		if err != nil || code != 0 {
			t.Errorf("nft -c %s: %d %v\n%s", filepath.Base(g), code, err, out.String())
		}
	}

	// Finally a mesh_status with the peer's handshake (sent every 30 s).
	for _, n := range nodes {
		cp.waitStatus(t, n.nodeID, 75*time.Second, "a peer handshake", func(s protocol.MeshStatus) bool {
			return s.Ready && len(s.Peers) == 1 && s.Peers[0].LastHandshakeMS != nil &&
				time.Since(time.UnixMilli(*s.Peers[0].LastHandshakeMS)) < 3*time.Minute
		})
	}
}

// -----------------------------------------------------------------------------
// Nodes
// -----------------------------------------------------------------------------

type node struct {
	nodeID string
	index  int
	mode   string

	id         string
	ip         string
	credential string
	enc        *ecdh.PrivateKey
	pub        string
}

func (n *node) meshAddr() string { return fmt.Sprintf("10.200.%d.1", n.index) }

func (n *node) start(t *testing.T, c *docker.Client, network string) {
	t.Helper()
	ctx := context.Background()
	name := dockertest.Unique("rh-it-mesh-" + n.nodeID + "-")
	id, err := c.CreateContainer(ctx, name, docker.ContainerCreate{
		Image:  dindImage,
		Env:    []string{"DOCKER_TLS_CERTDIR="},
		Labels: map[string]string{dockertest.TestLabel: "true"},
		HostConfig: docker.HostConfig{
			Privileged:  true,
			NetworkMode: network,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.RemoveContainer(context.Background(), id) })
	if err := c.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	n.id = id
	n.ip = dockertest.IP(t, c, id, network)
}

// provision waits for the node's engine, installs the test tools, loads
// the workload image and writes the agent, its keys and its config.
func (n *node) provision(ctx context.Context, c *docker.Client, bin []byte, imageID string, cp *fakeCP) error {
	deadline := time.Now().Add(90 * time.Second)
	for {
		if _, code := exec1(ctx, c, n.id, "docker info >/dev/null 2>&1"); code == 0 {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the node's Docker engine did not start")
		}
		time.Sleep(500 * time.Millisecond)
	}
	if out, code := exec1(ctx, c, n.id, "apk add --no-cache -q nftables bind-tools wireguard-tools busybox-extras"); code != 0 {
		return fmt.Errorf("apk add: %s", out)
	}
	img, err := c.SaveImages(ctx, imageID)
	if err != nil {
		return err
	}
	defer img.Close()
	var out bytes.Buffer
	code, err := c.RunExec(ctx, n.id, docker.ExecRun{Cmd: []string{"docker", "load"}, Stdin: img, Stdout: &out, Stderr: &out})
	if err != nil || code != 0 {
		return fmt.Errorf("docker load: %d %v %s", code, err, out.String())
	}
	// NOTE: An image ID is only meaningful to the engine that issued it. A
	// classic-store host (the GitHub runner) names busybox by its config
	// digest, while the node's containerd store names the same load by its
	// manifest digest, so tag whatever ID the node reports.
	loaded := loadedImageID(out.String())
	if loaded == "" {
		return fmt.Errorf("docker load named no image: %s", out.String())
	}
	if out, code := exec1(ctx, c, n.id, "docker tag "+loaded+" "+workloadImage); code != 0 {
		return fmt.Errorf("docker tag: %s", out)
	}

	dir, err := os.MkdirTemp("", "rh-mesh-node-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if _, err := nodekey.CreateIdentity(filepath.Join(dir, "identity.key")); err != nil {
		return err
	}
	if n.enc, err = nodekey.CreateEncryptionKey(filepath.Join(dir, "encryption.key")); err != nil {
		return err
	}
	n.credential = "nc_" + randomHex(16)
	cp.register(n)
	cfg := config.Config{
		ControlPlaneURL:   cp.origin(),
		NodeID:            n.nodeID,
		ConnectURL:        cp.connectURL(n.nodeID),
		ControlPublicKey:  base64.StdEncoding.EncodeToString(cp.pub),
		CredentialFile:    "/var/lib/roundhouse/credential",
		IdentityKeyFile:   "/var/lib/roundhouse/identity.key",
		EncryptionKeyFile: "/var/lib/roundhouse/encryption.key",
		StateFile:         "/var/lib/roundhouse/state.json",
		DataDir:           "/var/lib/roundhouse",
		Insecure:          true,
		Mesh:              config.MeshConfig{Mode: n.mode, Endpoint: n.ip + ":51820"},
	}
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := config.Save(cfgPath, cfg); err != nil {
		return err
	}
	files := []tarFile{{"usr/local/bin/roundhouse-agent", bin, 0o755}}
	for _, f := range []struct{ src, dst string }{
		{cfgPath, "etc/roundhouse/agent.yaml"},
		{filepath.Join(dir, "identity.key"), "var/lib/roundhouse/identity.key"},
		{filepath.Join(dir, "encryption.key"), "var/lib/roundhouse/encryption.key"},
	} {
		data, err := os.ReadFile(f.src)
		if err != nil {
			return err
		}
		files = append(files, tarFile{f.dst, data, 0o600})
	}
	files = append(files, tarFile{"var/lib/roundhouse/credential", []byte(n.credential), 0o600})
	return c.PutArchive(ctx, n.id, "/", tarball(files))
}

func (n *node) runAgent(t *testing.T, c *docker.Client) {
	t.Helper()
	script := protocolDevEnv + "=1 nohup /usr/local/bin/roundhouse-agent run --config /etc/roundhouse/agent.yaml >/var/log/roundhouse-agent.log 2>&1 &"
	if out, code := n.sh(t, c, script); code != 0 {
		t.Fatalf("start agent on %s: %s", n.nodeID, out)
	}
}

// protocolDevEnv mirrors conn.DevEnv: workloads over plaintext ws://.
const protocolDevEnv = "ROUNDHOUSE_DEV"

func (n *node) sh(t *testing.T, c *docker.Client, script string) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return exec1(ctx, c, n.id, script)
}

// inContainer runs script in the inner container of a workload.
func (n *node) inContainer(t *testing.T, c *docker.Client, workloadID, script string) (string, int) {
	t.Helper()
	return n.sh(t, c, fmt.Sprintf(`id=$(docker ps -q --filter label=roundhouse.workload_id=%s | head -n1) && [ -n "$id" ] && docker exec "$id" sh -c '%s'`, workloadID, script))
}

func (n *node) dump(t *testing.T, c *docker.Client) {
	for _, cmd := range []string{
		"tail -n 150 /var/log/roundhouse-agent.log",
		"nft list table inet roundhouse",
		"wg show",
		"ip -br addr",
		"iptables -S DOCKER-USER",
		"docker ps -a",
	} {
		out, _ := n.sh(t, c, cmd+" 2>&1")
		t.Logf("%s $ %s\n%s", n.nodeID, cmd, out)
	}
}

func exec1(ctx context.Context, c *docker.Client, id, script string) (string, int) {
	var out bytes.Buffer
	code, err := c.RunExec(ctx, id, docker.ExecRun{Cmd: []string{"sh", "-c", script}, Stdout: &out, Stderr: &out})
	if err != nil {
		return out.String() + err.Error(), -1
	}
	return out.String(), code
}

func waitContainer(t *testing.T, c *docker.Client, n *node, workloadID string) {
	t.Helper()
	eventually(t, 120*time.Second, workloadID+" running on "+n.nodeID, func() (bool, string) {
		out, _ := n.sh(t, c, "docker ps --filter label=roundhouse.workload_id="+workloadID+" --format '{{.Status}}'")
		return strings.HasPrefix(strings.TrimSpace(out), "Up"), out
	})
}

func eventually(t *testing.T, timeout time.Duration, what string, cond func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ok, last := cond()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s; last: %s", timeout, what, last)
		}
		time.Sleep(time.Second)
	}
}

// buildAgent cross-compiles the agent for the nodes.
func buildAgent(t *testing.T) []byte {
	t.Helper()
	gomod, err := exec.Command("go", "env", "GOMOD").Output()
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "roundhouse-agent")
	cmd := exec.Command("go", "build", "-o", out, "./cmd/roundhouse-agent")
	cmd.Dir = filepath.Dir(strings.TrimSpace(string(gomod)))
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build agent: %v\n%s", err, b)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

type tarFile struct {
	name string
	data []byte
	mode int64
}

func tarball(files []tarFile) io.Reader {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	dirs := map[string]bool{}
	for _, f := range files {
		for d := filepath.ToSlash(filepath.Dir(f.name)); d != "." && !dirs[d]; d = filepath.ToSlash(filepath.Dir(d)) {
			dirs[d] = true
		}
	}
	for _, d := range []string{"etc", "etc/roundhouse", "usr", "usr/local", "usr/local/bin", "var", "var/lib", "var/lib/roundhouse"} {
		if dirs[d] {
			mode := int64(0o755)
			if strings.HasPrefix(d, "var/lib/roundhouse") || d == "etc/roundhouse" {
				mode = 0o700
			}
			_ = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: d + "/", Mode: mode, ModTime: time.Now()})
		}
	}
	for _, f := range files {
		_ = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: f.name, Mode: f.mode, Size: int64(len(f.data)), ModTime: time.Now()})
		_, _ = tw.Write(f.data)
	}
	_ = tw.Close()
	return &buf
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// -----------------------------------------------------------------------------
// Fake control plane
// -----------------------------------------------------------------------------

// fakeCP serves the agents' control sockets: it answers hello with a signed
// welcome, pushes signed desired states sealed to each node's key, and
// records hellos and mesh_status frames.
type fakeCP struct {
	t    *testing.T
	ip   string
	port int
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	srv  *http.Server

	mu    sync.Mutex
	nodes map[string]*cpNode
	psk   []byte
	// pullPassword is node 2's password on node 1's mesh registry
	// listener; pullHash its bcrypt hash.
	pullPassword, pullHash string
	// filtered turns node 1's ingress filter on.
	filtered bool
}

type cpNode struct {
	n        *node
	hello    *protocol.Hello
	statuses []protocol.MeshStatus
	gen      int64
	desired  func(gen int64) *protocol.DesiredState
	out      chan []byte
}

func newFakeCP(t *testing.T, ip string) *fakeCP {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	psk := make([]byte, 32)
	_, _ = rand.Read(psk)
	password := randomHex(32)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	cp := &fakeCP{
		t: t, ip: ip, port: ln.Addr().(*net.TCPAddr).Port, pub: pub, priv: priv, nodes: map[string]*cpNode{}, psk: psk,
		pullPassword: password, pullHash: string(hash),
	}
	cp.srv = &http.Server{Handler: http.HandlerFunc(cp.serve), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = cp.srv.Serve(ln) }()
	t.Cleanup(func() { _ = cp.srv.Close() })
	return cp
}

func (cp *fakeCP) origin() string { return fmt.Sprintf("http://%s:%d", cp.ip, cp.port) }

func (cp *fakeCP) connectURL(nodeID string) string {
	return fmt.Sprintf("ws://%s:%d/connect/%s", cp.ip, cp.port, nodeID)
}

func (cp *fakeCP) register(n *node) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.nodes[n.nodeID] = &cpNode{n: n, out: make(chan []byte, 16)}
}

func (cp *fakeCP) serve(w http.ResponseWriter, r *http.Request) {
	nodeID := strings.TrimPrefix(r.URL.Path, "/connect/")
	cp.mu.Lock()
	cn := cp.nodes[nodeID]
	cp.mu.Unlock()
	if cn == nil || r.Header.Get("Authorization") != "Bearer "+cn.n.credential {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(8 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		defer cancel()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			msg, err := protocol.DecodeAgentMessage(data)
			if err != nil {
				cp.t.Logf("%s sent an invalid frame: %v: %s", nodeID, err, data)
				continue
			}
			switch m := msg.(type) {
			case *protocol.Hello:
				cp.mu.Lock()
				cn.hello = m
				cp.mu.Unlock()
				cp.sign(cn, &protocol.Welcome{Type: protocol.TypeWelcome, ControlHeader: cp.header(nodeID), HeartbeatIntervalMS: 10_000})
				// A reconnecting agent gets the current state again.
				cp.mu.Lock()
				planned := cn.desired != nil
				cp.mu.Unlock()
				if planned {
					cp.send(nodeID)
				}
			case *protocol.MeshStatus:
				cp.mu.Lock()
				cn.statuses = append(cn.statuses, *m)
				cp.mu.Unlock()
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-cn.out:
			if err := ws.Write(ctx, websocket.MessageText, b); err != nil {
				return
			}
		}
	}
}

func (cp *fakeCP) header(nodeID string) protocol.ControlHeader {
	now := time.Now()
	return protocol.ControlHeader{
		ID: "msg_" + randomHex(8), NodeID: nodeID,
		IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(50 * time.Second).UnixMilli(),
	}
}

func (cp *fakeCP) sign(cn *cpNode, msg protocol.ControlMessage) {
	env, err := protocol.SignEnvelope(msg, cp.priv, "kid_test")
	if err != nil {
		cp.t.Errorf("sign: %v", err)
		return
	}
	data, _ := json.Marshal(env)
	select {
	case cn.out <- data:
	default:
		cp.t.Errorf("control frame queue full for %s", cn.n.nodeID)
	}
}

func (cp *fakeCP) waitHellos(t *testing.T, timeout time.Duration, nodes []*node) map[string]*protocol.Hello {
	t.Helper()
	out := map[string]*protocol.Hello{}
	eventually(t, timeout, "both agents' hello", func() (bool, string) {
		cp.mu.Lock()
		defer cp.mu.Unlock()
		for _, n := range nodes {
			if h := cp.nodes[n.nodeID].hello; h != nil {
				out[n.nodeID] = h
			}
		}
		return len(out) == len(nodes), fmt.Sprintf("%d of %d", len(out), len(nodes))
	})
	return out
}

func (cp *fakeCP) waitStatus(t *testing.T, nodeID string, timeout time.Duration, what string, ok func(protocol.MeshStatus) bool) {
	t.Helper()
	eventually(t, timeout, nodeID+" mesh_status with "+what, func() (bool, string) {
		cp.mu.Lock()
		defer cp.mu.Unlock()
		ss := cp.nodes[nodeID].statuses
		if len(ss) == 0 {
			return false, "no mesh_status yet"
		}
		last := ss[len(ss)-1]
		b, _ := json.Marshal(last)
		return ok(last), string(b)
	})
}

// send sends the node a desired state at a new generation.
func (cp *fakeCP) send(nodeID string) {
	cp.mu.Lock()
	cn := cp.nodes[nodeID]
	cn.gen++
	gen, build := cn.gen, cn.desired
	cp.mu.Unlock()
	ds := build(gen)
	// The agent decodes strictly; catch a malformed frame here, not as a
	// silent drop on the node.
	data, err := json.Marshal(ds)
	if err == nil {
		_, err = protocol.DecodeControlMessage(data)
	}
	if err != nil {
		cp.t.Errorf("invalid desired state for %s: %v", nodeID, err)
		return
	}
	cp.sign(cn, ds)
}

// plan sets each node's desired state: env A's web on node 1; env A's
// client, env B's intruder and a route workload for web on node 2.
func (cp *fakeCP) plan(nodes []*node) {
	n1, n2 := nodes[0], nodes[1]
	healthy := true
	addrA := []protocol.MeshAddress{
		{IP: webIP, EnvTag: envATag, NodeID: n1.nodeID, RoutedPorts: []int{80}, PrivateDomain: webDomain, Healthy: &healthy},
		{IP: clientIP, EnvTag: envATag, NodeID: n2.nodeID, RoutedPorts: []int{}, PrivateDomain: "client.production.proj.internal", Healthy: &healthy},
	}
	addrB := protocol.MeshAddress{IP: intruder, EnvTag: envBTag, NodeID: n2.nodeID, RoutedPorts: []int{}, PrivateDomain: "intruder.staging.proj.internal"}
	meshFor := func(self, peer *node, gen int64, addrs []protocol.MeshAddress) *protocol.MeshConfig {
		ep := peer.ip + ":51820"
		m := &protocol.MeshConfig{
			Supernet: "10.200.0.0/16", NodeIndex: self.index, Address: self.meshAddr(),
			DNSAddress: fmt.Sprintf("10.200.%d.2", self.index), ListenPort: 51820, MTU: 1420, AcceptFwmark: 0x2000000,
			Peers: []protocol.MeshPeer{{
				NodeID: peer.nodeID, PublicKey: peer.pub, Endpoint: &ep,
				AllowedIPs: []string{fmt.Sprintf("10.200.%d.0/24", peer.index)}, KeepaliveS: 25,
			}},
			ForwardPairs:  [][]string{},
			NodeAddresses: []string{n1.meshAddr(), n2.meshAddr()},
			Addresses:     addrs,
		}
		pt, _ := json.Marshal(protocol.SealedMeshPSKs{PSKs: map[string]string{peer.nodeID: base64.StdEncoding.EncodeToString(cp.psk)}})
		box, err := protocol.SealBox(self.enc.PublicKey(), pt, protocol.BoxPurposeMeshPSKs, protocol.MeshPSKsAAD(self.nodeID, gen))
		if err != nil {
			cp.t.Errorf("seal psks: %v", err)
		}
		m.PSKsSealed = box
		return m
	}
	ds := func(self *node, gen int64, mesh *protocol.MeshConfig, ws ...protocol.WorkloadSpec) *protocol.DesiredState {
		for i := range ws {
			if ws[i].Kind == protocol.WorkloadService {
				sealtest.SealWorkload(cp.t, self.enc.PublicKey(), self.nodeID, gen, &ws[i], nil, nil)
			}
		}
		return &protocol.DesiredState{
			Type: protocol.TypeDesiredState, ControlHeader: cp.header(self.nodeID), Generation: gen,
			Workloads: ws, TLSMode: protocol.TLSOff, Mesh: mesh,
		}
	}
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.nodes[n1.nodeID].desired = func(gen int64) *protocol.DesiredState {
		web := service("wl_web", "svc_web", envA, webIP, []string{"sh", "-c", webScript})
		web.Healthcheck = &protocol.Healthcheck{Type: protocol.HealthcheckHTTP, Path: "/", Port: 80, IntervalS: 1, TimeoutS: 2, Retries: 3}
		web.Ports = []protocol.WorkloadPort{{ContainerPort: 80, Protocol: protocol.PortHTTP}, {ContainerPort: 8080, Protocol: protocol.PortHTTP}}
		web.Routes = []protocol.WorkloadRoute{{Hostname: routeHost, ContainerPort: 80}}
		d := ds(n1, gen, meshFor(n1, n2, gen, addrA), rehash(web))
		// The builder: a filesystem primary that node 2 pulls from over the
		// mesh.
		d.Registry = &protocol.RegistryConfig{
			Listen: protocol.RegistryListen, Storage: protocol.RegistryStorage{Type: protocol.StorageFilesystem},
			MeshListen: n1.meshAddr() + ":5000",
			PullUsers:  []protocol.RegistryPullUser{{Username: pullUser, Bcrypt: cp.pullHash}},
		}
		cp.mu.Lock()
		if cp.filtered {
			sources := slices.Clone(ingressSources)
			d.Ingress = &protocol.IngressSettings{AllowedSources: &sources, ManagedHosts: []string{}}
		}
		cp.mu.Unlock()
		return d
	}
	cp.nodes[n2.nodeID].desired = func(gen int64) *protocol.DesiredState {
		client := service("wl_client", "svc_client", envA, clientIP, []string{"sleep", "3600"})
		intr := service("wl_intruder", "svc_intruder", envB, intruder, []string{"sleep", "3600"})
		route := service("wl_route", "svc_web", envA, "", nil)
		route.Kind, route.PrivateDNS = protocol.WorkloadRouteOnly, nil
		route.Ports = []protocol.WorkloadPort{{ContainerPort: 80, Protocol: protocol.PortHTTP}}
		route.Routes = []protocol.WorkloadRoute{{Hostname: routeHost, ContainerPort: 80}}
		route.Upstreams = []protocol.Upstream{{IP: webIP, Port: 80}}
		d := ds(n2, gen, meshFor(n2, n1, gen, append(addrA[:2:2], addrB)), rehash(client), rehash(intr), rehash(route))
		pt, _ := json.Marshal(protocol.SealedRegistryUpstream{Password: cp.pullPassword})
		box, err := protocol.SealBox(n2.enc.PublicKey(), pt, protocol.BoxPurposeRegistryUpstream, protocol.RegistryUpstreamAAD(n2.nodeID, gen))
		if err != nil {
			cp.t.Errorf("seal upstream password: %v", err)
		}
		d.Registry = &protocol.RegistryConfig{
			Listen: protocol.RegistryListen, Mode: protocol.RegistryProxy,
			Storage:  protocol.RegistryStorage{Type: protocol.StorageFilesystem},
			Upstream: &protocol.RegistryUpstream{URL: "http://" + n1.meshAddr() + ":5000", Username: pullUser, PasswordSealed: *box},
		}
		return d
	}
}

func service(id, serviceID, env, meshIP string, cmd []string) protocol.WorkloadSpec {
	yes := true
	proj, envID, svc, dep := project, env, serviceID, "dep_"+strings.TrimPrefix(id, "wl_")
	return protocol.WorkloadSpec{
		ID: id, Kind: protocol.WorkloadService,
		ProjectID: &proj, EnvironmentID: &envID, ServiceID: &svc, DeploymentID: &dep,
		Image: workloadImage, Command: cmd,
		Ports: []protocol.WorkloadPort{}, Routes: []protocol.WorkloadRoute{},
		Resources: protocol.Resources{CPUMillis: 250, MemoryMB: 64, PIDs: 64},
		Restart:   protocol.Restart{Policy: protocol.RestartAlways},
		Network:   protocol.EnvironmentNetworkName(project, env),
		Labels:    map[string]string{},
		MeshIP:    meshIP, PrivateDNS: &yes,
	}
}

func rehash(w protocol.WorkloadSpec) protocol.WorkloadSpec {
	h, err := protocol.ComputeSpecHash(w)
	if err != nil {
		panic(err)
	}
	w.SpecHash = h
	return w
}

// loadedImageID finds the image docker load created in its output: "Loaded
// image ID: sha256:…" for an untagged archive, or "Loaded image: name:tag".
func loadedImageID(out string) string {
	for line := range strings.Lines(out) {
		line = strings.TrimSpace(line)
		if id, ok := strings.CutPrefix(line, "Loaded image ID: "); ok {
			return id
		}
		if ref, ok := strings.CutPrefix(line, "Loaded image: "); ok {
			return ref
		}
	}
	return ""
}

// pushedDigest finds the manifest digest in docker push's output
// ("it: digest: sha256:… size: …").
func pushedDigest(out string) string {
	for line := range strings.Lines(out) {
		if _, rest, ok := strings.Cut(line, "digest: "); ok {
			if d, _, _ := strings.Cut(strings.TrimSpace(rest), " "); strings.HasPrefix(d, "sha256:") && len(d) == 71 {
				return d
			}
		}
	}
	return ""
}
