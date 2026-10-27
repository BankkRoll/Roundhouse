package backup

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
)

func baseTar(t *testing.T, files map[string]string, order ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, name := range order {
		body := files[name]
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const label = `START WAL LOCATION: 0/2000028 (file 000000010000000000000002)
CHECKPOINT LOCATION: 0/2000080
BACKUP METHOD: streamed
BACKUP FROM: primary
START TIME: 2026-10-27 12:00:00 UTC
LABEL: roundhouse bak_1
START TIMELINE: 1
`

func TestWALStartComesFromTheBackupLabel(t *testing.T) {
	got, err := walStartOf(baseTar(t, map[string]string{"backup_label": label, "PG_VERSION": "18\n"}, "backup_label", "PG_VERSION"))
	if err != nil || got != "000000010000000000000002" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := walStartOf(baseTar(t, map[string]string{"PG_VERSION": "18\n"}, "PG_VERSION")); err == nil {
		t.Fatal("found a start in a tar without backup_label")
	}
	bad := strings.Replace(label, "(file 000000010000000000000002)", "(file ../etc)", 1)
	if _, err := walStartOf(baseTar(t, map[string]string{"backup_label": bad}, "backup_label")); err == nil {
		t.Fatal("accepted a label whose segment is not a WAL name")
	}
	// Only the start of the stream is kept; the label must be in it.
	p := &prefixWriter{max: 10}
	_, _ = p.Write([]byte("0123456789abcdef"))
	if string(p.buf) != "0123456789" {
		t.Fatalf("prefix %q", p.buf)
	}
}

func TestReplayMustReachTheLastFetchedSegment(t *testing.T) {
	pgdata := t.TempDir()
	if err := os.Mkdir(filepath.Join(pgdata, "pg_wal"), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(pgdata, "pg_wal", name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkReplayedThrough(pgdata, "000000010000000000000005"); err == nil {
		t.Fatal("passed without a timeline history")
	}
	// Promoted in segment 4 while segment 5 was fetched: a gap.
	write("00000002.history", "1\t0/4000148\tno recovery target specified\n")
	if err := checkReplayedThrough(pgdata, "000000010000000000000005"); err == nil || !strings.Contains(err.Error(), "gap") {
		t.Fatalf("a gap went unnoticed: %v", err)
	}
	write("00000002.history", "1\t0/5000148\tno recovery target specified\n")
	if err := checkReplayedThrough(pgdata, "000000010000000000000005"); err != nil {
		t.Fatal(err)
	}
	// The newest timeline counts, across a log boundary.
	write("00000003.history", "1\t0/5000148\tno recovery target specified\n\n2\t1/00000010\tbefore 2026-10-27 12:00:00+00\n")
	if err := checkReplayedThrough(pgdata, "0000000200000000000000FF"); err != nil {
		t.Fatal(err)
	}
	if n, err := segmentNumber("000000010000000100000000"); err != nil || n != 256 {
		t.Fatalf("segment number %d, %v", n, err)
	}
	if _, err := segmentOfLSN("nope"); err == nil {
		t.Fatal("parsed an invalid LSN")
	}
}

func TestLayoutFindsPGDATAInsideTheVolume(t *testing.T) {
	info := docker.ContainerInfo{
		Config: docker.ContainerConfig{Env: []string{"PGDATA=/var/lib/postgresql/18/docker", "POSTGRES_USER=postgres"}},
		Mounts: []docker.MountPoint{{Source: "/vols/mnt/vol_1/data", Destination: "/var/lib/postgresql"}},
	}
	l, err := layoutOf(info, "/vols/mnt/vol_1/data")
	if err != nil || l.mountPath != "/var/lib/postgresql" || l.rel != "18/docker" {
		t.Fatalf("layout %+v, %v", l, err)
	}
	info.Config.Env = []string{"PGDATA=/srv/elsewhere"}
	if _, err := layoutOf(info, "/vols/mnt/vol_1/data"); err == nil {
		t.Fatal("accepted a PGDATA outside the volume")
	}
	info.Config.Env = []string{"PGDATA=/var/lib/postgresql/../../etc"}
	if _, err := layoutOf(info, "/vols/mnt/vol_1/data"); err == nil {
		t.Fatal("accepted a PGDATA that climbs out")
	}
	if _, err := layoutOf(info, "/vols/mnt/vol_2/data"); err == nil {
		t.Fatal("accepted a container that does not mount the volume")
	}
}
