package backup

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/BankkRoll/Roundhouse/agent/internal/docker"
	"github.com/BankkRoll/Roundhouse/agent/internal/rhbk"
	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// execDocker records the exec calls a task makes, with their stdin.
type execDocker struct {
	Docker
	calls []execCall
}

type execCall struct {
	cmd   []string
	stdin string
}

func (d *execDocker) RunExec(ctx context.Context, _ string, run docker.ExecRun) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	c := execCall{cmd: run.Cmd}
	if run.Stdin != nil {
		b, _ := io.ReadAll(run.Stdin)
		c.stdin = string(b)
	}
	d.calls = append(d.calls, c)
	return 0, nil
}

const (
	envPassword   = "env-password-0123456789"
	envROPassword = "env-ro-password-0123456789"
)

func execTarget(d *execDocker, env ...string) *engineTarget {
	return &engineTarget{d: d, container: "ctr_db", env: envMap(env)}
}

// argvFree fails when any exec's argument vector carries a password.
func argvFree(t *testing.T, calls []execCall) {
	t.Helper()
	for _, c := range calls {
		for _, a := range c.cmd {
			for _, pw := range []string{envPassword, envROPassword} {
				if strings.Contains(a, pw) {
					t.Fatalf("argv carries a password: %q", c.cmd)
				}
			}
		}
	}
}

func TestPostgresGlobalsRestoreReappliesTheContainersCredentials(t *testing.T) {
	d := &execDocker{}
	target := execTarget(d, "POSTGRES_USER=postgres", "POSTGRES_PASSWORD="+envPassword, "ROUNDHOUSE_RO_PASSWORD="+envROPassword)
	globals := "ALTER ROLE postgres WITH SUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$4096:old';\n"
	h := rhbk.Header{Name: "_globals.sql", Engine: "postgres", Format: rhbk.FormatPGGlobals}
	if err := target.restoreEntry(context.Background(), protocol.EnginePostgres, h, strings.NewReader(globals)); err != nil {
		t.Fatal(err)
	}
	if len(d.calls) != 2 || d.calls[0].stdin != globals {
		t.Fatalf("calls %+v", d.calls)
	}
	reapply := d.calls[1]
	if reapply.stdin != pgCredentialsScript || !strings.Contains(reapply.cmd[2], `exec psql -X -q -U "$U" -d postgres -f -`) {
		t.Fatalf("credentials call %+v", reapply)
	}
	for _, want := range []string{`\getenv rh_password POSTGRES_PASSWORD`, `\getenv rh_ro_password ROUNDHOUSE_RO_PASSWORD`,
		"SET log_min_error_statement = 'panic'", "SET log_min_duration_statement = -1", `%L`} {
		if !strings.Contains(pgCredentialsScript, want) {
			t.Errorf("credentials script lacks %q", want)
		}
	}
	argvFree(t, d.calls)
}

func TestMongoRestoreKeepsTheTargetsPrincipals(t *testing.T) {
	d := &execDocker{}
	target := execTarget(d, "MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD="+envPassword, "ROUNDHOUSE_RO_PASSWORD="+envROPassword)
	h := rhbk.Header{Name: "mongo.archive", Engine: "mongodb", Format: rhbk.FormatMongoArchive}
	if err := target.restoreEntry(context.Background(), protocol.EngineMongoDB, h, strings.NewReader("archive")); err != nil {
		t.Fatal(err)
	}
	if len(d.calls) != 1 || d.calls[0].stdin != "archive" {
		t.Fatalf("calls %+v", d.calls)
	}
	cmd := d.calls[0].cmd
	if cmd[len(cmd)-3] != mongoMergeScript || !strings.Contains(cmd[2], "--nsFrom=admin.system.users --nsTo=\"$2\"") {
		t.Fatalf("restore call %q", cmd)
	}
	for _, want := range []string{"_mergeAuthzCollections", "for (const name of [user, 'roundhouse_ro'])", "drop: true"} {
		if !strings.Contains(mongoMergeScript, want) {
			t.Errorf("restore script lacks %q", want)
		}
	}
	argvFree(t, d.calls)
}

func TestMySQLDumpRefusesSystemSchemas(t *testing.T) {
	d := &execDocker{}
	target := execTarget(d, "MYSQL_ROOT_PASSWORD="+envPassword)
	dbs := []string{"app", "mysql"}
	err := target.dumpMySQL(context.Background(), &dbs, nil)
	if err == nil || !strings.Contains(err.Error(), "system schema") || len(d.calls) != 0 {
		t.Fatalf("err %v, calls %+v", err, d.calls)
	}
}

func TestCredentialsTimeoutOutlivesTheRestoresDeadline(t *testing.T) {
	d := &execDocker{}
	target := execTarget(d, "POSTGRES_PASSWORD="+envPassword)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if err := target.reapplyPostgresCredentials(ctx); err != nil || len(d.calls) != 1 {
		t.Fatalf("err %v, calls %d", err, len(d.calls))
	}
}
