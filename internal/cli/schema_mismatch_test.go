package cli

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/output"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// A store at a schema version this binary does not write is the one failure
// that must never reach a command body. A binary that queried it anyway
// would, at best, return a raw engine error about a column that does not
// exist; at worst it would answer — a listing missing exactly the rows a
// column it has never heard of would have matched. Either is worse than
// refusing, so every command checks the version first and says which way the
// mismatch goes.

// setRecordedVersion rewrites the schema version in the harness database
// behind the tool's back, which is how a store at the wrong version is built
// without a second binary to build it with. It writes only the meta row, so
// the data stays exactly what the commands under test would otherwise read.
func (h *harness) setRecordedVersion(v int) {
	h.t.Helper()
	db, err := sql.Open("sqlite", "file:"+h.db)
	if err != nil {
		h.t.Fatalf("opening the database to plant version %d: %v", v, err)
	}
	defer db.Close()
	if _, err := db.Exec(schema.SetVersionSQL, schema.MetaKey, strconv.Itoa(v)); err != nil {
		h.t.Fatalf("planting schema version %d: %v", v, err)
	}
}

// recordedVersion reads the marker back, so a test can assert that a command
// which refused also left it alone.
func recordedVersion(t *testing.T, h *harness) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+h.db)
	if err != nil {
		t.Fatalf("opening the database to read the version: %v", err)
	}
	defer db.Close()
	var raw string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = ?`, schema.MetaKey).Scan(&raw); err != nil {
		t.Fatalf("reading the recorded version: %v", err)
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("the recorded version %q is not a number", raw)
	}
	return v
}

func TestNoCommandReadsOrWritesAStoreAtTheWrongSchemaVersion(t *testing.T) {
	cases := []struct {
		name    string
		version int
		advice  string
	}{
		{
			name: "a store older than the binary is told to migrate",
			// Below Version is the state `tdo migrate` exists for.
			version: schema.Version - 1,
			advice:  "run `tdo migrate`",
		},
		{
			name: "a store newer than the binary is told to upgrade tdo",
			// Above Version is a store some later tdo wrote. There is
			// nothing to migrate and guessing at it is how data is lost.
			version: schema.Version + 1,
			advice:  "upgrade tdo",
		},
	}

	// The whole surface a user reaches on an ordinary day: the reads that
	// could answer wrongly and the writes that could write wrongly.
	commands := [][]string{
		{"ls"},
		{"ls", "--json"},
		{"ls", "--all", "--json"},
		{"ls", "--tree"},
		{"next", "--json"},
		{"inbox", "--json"},
		{"review", "--json"},
		{"project", "ls", "--json"},
		{"folder", "ls", "--json"},
		{"perspective", "ls", "--json"},
		{"export", "--all", "--json"},
		{"add", "Written against the wrong schema", "--json"},
		{"edit", "REF", "--title", "Renamed", "--json"},
		{"done", "REF", "--json"},
		{"undone", "REF", "--json"},
		{"drop", "REF", "--json"},
		{"flag", "REF", "--json"},
		{"mv", "REF", "--inbox", "--json"},
		{"repeat", "REF", "1w", "--json"},
		{"rm", "REF", "--json"},
		{"rm", "REF", "--purge", "--yes", "--json"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			id := h.taskOf(h.mustRun("add", "Written before the mismatch", "--json"))["id"].(string)
			title := "Written before the mismatch"
			h.setRecordedVersion(tc.version)

			for _, args := range commands {
				run := make([]string, len(args))
				for i, a := range args {
					if a == "REF" {
						a = id
					}
					run[i] = a
				}
				t.Run(strings.Join(args, " "), func(t *testing.T) {
					res := h.run(run...)
					if res.code != 3 {
						t.Fatalf("exit %d, want 3\nstdout: %q\nstderr: %q", res.code, res.stdout, res.stderr)
					}
					both := res.stdout + res.stderr
					if !strings.Contains(both, tc.advice) {
						t.Errorf("the refusal does not say %q:\nstdout: %q\nstderr: %q", tc.advice, res.stdout, res.stderr)
					}
					if !strings.Contains(both, fmt.Sprintf("schema version %d", tc.version)) {
						t.Errorf("the refusal does not name the version found:\nstdout: %q\nstderr: %q", res.stdout, res.stderr)
					}
					// Nothing of the task list may leak out of a command
					// that refused: a partial answer is the wrong answer
					// this check exists to prevent.
					if strings.Contains(res.stdout, title) {
						t.Errorf("a refused command still printed task data: %q", res.stdout)
					}
				})
			}

			// The store is untouched: once the version is put back, the
			// task is exactly where it was and nothing was written to it.
			h.setRecordedVersion(schema.Version)
			tasks := h.tasksOf(h.mustRun("ls", "--all", "--json"))
			if len(tasks) != 1 || tasks[0]["title"] != title {
				t.Fatalf("the refused commands changed the store: %v", tasks)
			}
		})
	}
}

// The four administrative commands are exempt, because each of them is
// either the fix for a mismatch or incapable of reading one wrongly.
func TestTheAdministrativeCommandsStillWorkOnAMismatchedStore(t *testing.T) {
	h := newHarness(t)
	h.setRecordedVersion(schema.Version + 1)

	// version and config read no store at all.
	if got := h.decode(h.mustRun("version", "--json")); got["version"] == nil {
		t.Errorf("version: %v", got)
	}
	if got := h.decode(h.mustRun("config", "--json")); got["provider"] != "sqlite" {
		t.Errorf("config: %v", got)
	}

	// doctor reports the mismatch through its own shape, not the error
	// envelope, and says which way it goes.
	res := h.run("doctor", "--json")
	if res.code != 1 {
		t.Fatalf("doctor exit %d, want 1\nstdout: %q", res.code, res.stdout)
	}
	report := h.decode(res)
	if report["ok"] != false {
		t.Errorf("doctor is happy with a mismatched store: %v", report)
	}
	if report["from"] != float64(schema.Version+1) || report["to"] != float64(schema.Version) {
		t.Errorf("doctor does not report the versions: %v", report)
	}
	if !strings.Contains(res.stdout, "upgrade tdo") {
		t.Errorf("doctor does not say what to do: %q", res.stdout)
	}

	// migrate gets past the preamble and refuses on its own terms: there is
	// no migration backwards, so the advice is to upgrade tdo.
	res = h.run("migrate", "--json")
	if res.code != 3 {
		t.Fatalf("migrate exit %d, want 3\nstdout: %q\nstderr: %q", res.code, res.stdout, res.stderr)
	}
	if !strings.Contains(res.stdout, "upgrade tdo") {
		t.Errorf("migrate does not say what to do: %q", res.stdout)
	}

	// init opens the store unchecked, because a store it is pointed at may
	// have no schema at all — but it is idempotent, so it also meets stores
	// that already have one. Against a store from the future it must refuse
	// rather than stamp this binary's version over the higher one: that
	// would leave the marker describing a schema that is not there, and
	// every later version check would pass while the two disagreed.
	res = h.run("init", "--json")
	if res.code != 3 {
		t.Errorf("init against a store from the future exits %d, want 3\nstdout: %q\nstderr: %q",
			res.code, res.stdout, res.stderr)
	}
	if !strings.Contains(res.stdout, "upgrade tdo") {
		t.Errorf("init does not say what to do: %q", res.stdout)
	}
	// And the marker is untouched, which is the part that matters.
	if got := recordedVersion(t, h); got != schema.Version+1 {
		t.Errorf("init rewrote the recorded version to %d; it must stay %d", got, schema.Version+1)
	}
}

// remoteStore is a store with no Backupper: exactly what every remote
// provider is. store.PlanMigration therefore reports that nothing can be
// copied aside, and `tdo migrate` has to ask before it goes ahead.
//
// It is built by embedding the interface rather than by standing up a fake
// server, because what is under test is the command layer's handling of a
// plan it cannot back up, not any provider's transport.
type remoteStore struct{ store.Store }

func (remoteStore) Describe() string { return "turso: libsql://example.turso.io" }

// appFor builds the command layer against the harness's configuration,
// without going through Run, so that a body taking a store can be handed one
// the configured provider would never produce.
func (h *harness) appFor(stdin string) (*app, *bytes.Buffer, *bytes.Buffer) {
	h.t.Helper()
	var out, errb bytes.Buffer
	a := &app{env: Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(stdin),
		Getenv: func(key string) string { return h.env[key] },
	}}
	a.out = output.Printer{Out: &out, Err: &errb}
	return a, &out, &errb
}

func TestMigratingAStoreThatCannotBeBackedUpRefusesRatherThanPromptWithoutATerminal(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Written before the migration")
	// One version behind, so that there is a migration to refuse.
	h.setRecordedVersion(schema.Version - 1)

	a, _, errb := h.appFor("")
	st, err := a.openStore(false)
	if err != nil {
		t.Fatalf("opening the store: %v", err)
	}
	defer st.Close()
	remote := remoteStore{st}

	err = a.migrate(context.Background(), remote, false)
	if err == nil {
		t.Fatal("migrate went ahead on a store it could not back up, with nobody to confirm")
	}
	if code, _ := exit.Classify(err); code != exit.Usage {
		t.Errorf("the refusal exits %d, want %d — it is the same shape as `tdo rm --purge`", code, exit.Usage)
	}
	for _, want := range []string{"pass --yes", "cannot take a backup", remote.Describe()} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not mention %q: %v", want, err)
		}
	}
	// A refusal is not a prompt: nothing was asked, so nothing was written
	// to stderr expecting an answer.
	if strings.Contains(errb.String(), "[y/N]") {
		t.Errorf("migrate prompted with no terminal to prompt at: %q", errb.String())
	}

	// With --yes the warning is behind it and the migration is attempted;
	// whatever it then reports, it is no longer the refusal.
	a, _, _ = h.appFor("")
	if err := a.migrate(context.Background(), remote, true); err != nil && strings.Contains(err.Error(), "pass --yes") {
		t.Errorf("--yes did not get past the refusal: %v", err)
	}
}
