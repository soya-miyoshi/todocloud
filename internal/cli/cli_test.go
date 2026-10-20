package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// harness runs the real command tree against a temporary SQLite database and
// a temporary state directory, capturing both streams. Every test goes
// through RunWith, so nothing is tested that the binary does not do.
type harness struct {
	t   *testing.T
	dir string
	db  string
	env map[string]string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	db := filepath.Join(dir, "tasks.db")

	// shortref reads the state directory from the process environment, so the
	// cache has to be redirected there as well as in the injected one.
	state := filepath.Join(dir, "state")
	t.Setenv("TODOCLOUD_STATE_DIR", state)

	h := &harness{
		t:   t,
		dir: dir,
		db:  db,
		env: map[string]string{
			"TODOCLOUD_PROVIDER":    "sqlite",
			"TODOCLOUD_SQLITE_PATH": db,
			"TODOCLOUD_STATE_DIR":   state,
			// Keep the developer's own configuration out of the test.
			"HOME":             dir,
			"XDG_CONFIG_HOME":  filepath.Join(dir, "config"),
			"XDG_STATE_HOME":   state,
			"TODOCLOUD_CONFIG": "",
		},
	}
	h.mustRun("init")
	return h
}

// result is one command's observable behaviour.
type result struct {
	code   int
	stdout string
	stderr string
}

func (h *harness) run(args ...string) result {
	h.t.Helper()
	var out, errb bytes.Buffer
	env := Env{
		Stdout: &out,
		Stderr: &errb,
		Stdin:  strings.NewReader(""),
		Getenv: func(key string) string { return h.env[key] },
	}
	code := RunWith(context.Background(), env, append([]string{"tdo"}, args...))
	return result{code: code, stdout: out.String(), stderr: errb.String()}
}

// mustRun fails the test unless the command exits 0.
func (h *harness) mustRun(args ...string) result {
	h.t.Helper()
	res := h.run(args...)
	if res.code != 0 {
		h.t.Fatalf("tdo %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), res.code, res.stdout, res.stderr)
	}
	return res
}

// decode parses stdout as a single JSON object, which also asserts that
// nothing but JSON reached stdout.
func (h *harness) decode(res result) map[string]any {
	h.t.Helper()
	var v map[string]any
	dec := json.NewDecoder(strings.NewReader(res.stdout))
	if err := dec.Decode(&v); err != nil {
		h.t.Fatalf("stdout is not JSON: %q: %v", res.stdout, err)
	}
	if dec.More() {
		h.t.Fatalf("stdout holds more than one JSON value: %q", res.stdout)
	}
	return v
}

// taskOf pulls the single task out of a {"task":{…}} response.
func (h *harness) taskOf(res result) map[string]any {
	h.t.Helper()
	obj := h.decode(res)
	t, ok := obj["task"].(map[string]any)
	if !ok {
		h.t.Fatalf("no task object in %q", res.stdout)
	}
	return t
}

// tasksOf pulls the list out of a {"tasks":[…]} response.
func (h *harness) tasksOf(res result) []map[string]any {
	h.t.Helper()
	obj := h.decode(res)
	raw, ok := obj["tasks"].([]any)
	if !ok {
		h.t.Fatalf("no tasks array in %q", res.stdout)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		t, ok := e.(map[string]any)
		if !ok {
			h.t.Fatalf("task is not an object in %q", res.stdout)
		}
		out = append(out, t)
	}
	return out
}

func TestAddThenList(t *testing.T) {
	h := newHarness(t)

	added := h.taskOf(h.mustRun("add", "Pay", "the", "invoice", "--due", "2026-11-01", "--priority", "2", "--tag", "finance", "--json"))
	if added["title"] != "Pay the invoice" {
		t.Fatalf("title round trip: %v", added["title"])
	}
	if added["due_at"] != "2026-11-01T00:00:00Z" || added["priority"] != float64(2) {
		t.Fatalf("well-known fields: %v", added)
	}

	listed := h.mustRun("ls", "--json")
	obj := h.decode(listed)
	if obj["count"] != float64(1) {
		t.Fatalf("count: %v", obj["count"])
	}
	tasks := h.tasksOf(listed)
	if tasks[0]["id"] != added["id"] {
		t.Fatalf("id round trip: %v vs %v", tasks[0]["id"], added["id"])
	}

	// The human-readable table is a table, and it stays narrow.
	text := h.mustRun("ls")
	if !strings.Contains(text.stdout, "Pay the invoice") {
		t.Fatalf("table is missing the title: %q", text.stdout)
	}
	for _, line := range strings.Split(strings.TrimRight(text.stdout, "\n"), "\n") {
		if len(line) > 80 {
			t.Fatalf("table line is wider than 80 columns: %q", line)
		}
	}
}

func TestGlobalJSONFlagBeforeSubcommand(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Before the subcommand")
	h.decode(h.mustRun("--json", "ls"))
}

func TestAddSetKeepsNestedValueUnchanged(t *testing.T) {
	h := newHarness(t)

	const nested = `{"owner":"ana","steps":[1,2,3]}`
	added := h.taskOf(h.mustRun("add", "Nested", "--set", "plan="+nested, "--set", "estimate=3", "--set", "ref=3.0.1", "--json"))
	if added["estimate"] != float64(3) {
		t.Fatalf("--set estimate=3 should store a number, got %T %v", added["estimate"], added["estimate"])
	}
	if added["ref"] != "3.0.1" {
		t.Fatalf("--set ref=3.0.1 should store a string, got %v", added["ref"])
	}

	shown := h.taskOf(h.mustRun("show", added["id"].(string), "--json"))
	plan, ok := shown["plan"].(map[string]any)
	if !ok {
		t.Fatalf("the nested field did not survive: %v", shown["plan"])
	}
	if plan["owner"] != "ana" {
		t.Fatalf("nested owner: %v", plan["owner"])
	}
	steps, ok := plan["steps"].([]any)
	if !ok || len(steps) != 3 || steps[2] != float64(3) {
		t.Fatalf("nested steps: %v", plan["steps"])
	}
}

func TestAddRejectsReservedField(t *testing.T) {
	h := newHarness(t)
	res := h.run("add", "Reserved", "--set", "id=nope")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (stderr %q)", res.code, res.stderr)
	}
}

func TestShortNumberResolution(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Numbered", "--json"))
	id := added["id"].(string)

	// Without a listing there is no number to resolve, and the error says so.
	missing := h.run("done", "1")
	if missing.code != 5 {
		t.Fatalf("exit %d, want 5", missing.code)
	}
	if !strings.Contains(missing.stderr, "tdo ls") {
		t.Fatalf("the error should point at `tdo ls`: %q", missing.stderr)
	}

	h.mustRun("ls")
	done := h.tasksOf(h.mustRun("done", "1", "--json"))
	if len(done) != 1 || done[0]["id"] != id || done[0]["done"] != true {
		t.Fatalf("done 1 did not complete the listed task: %v", done)
	}
	if done[0]["completed_at"] == nil {
		t.Fatalf("completed_at should be set: %v", done[0])
	}

	undone := h.tasksOf(h.mustRun("undone", id[:6], "--json"))
	if undone[0]["done"] != false || undone[0]["completed_at"] != nil {
		t.Fatalf("undone by prefix: %v", undone[0])
	}
}

func TestShortNumberCacheIsPerStore(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "First store")
	h.mustRun("ls")

	// A listing from one database must never number a task in another.
	other := filepath.Join(h.dir, "other.db")
	h.env["TODOCLOUD_SQLITE_PATH"] = other
	h.mustRun("init")
	res := h.run("done", "1")
	if res.code != 5 {
		t.Fatalf("exit %d, want 5 (stderr %q)", res.code, res.stderr)
	}
}

func TestAmbiguousPrefix(t *testing.T) {
	h := newHarness(t)
	first := h.taskOf(h.mustRun("add", "One", "--json"))["id"].(string)
	second := h.taskOf(h.mustRun("add", "Two", "--json"))["id"].(string)

	// Ids generated milliseconds apart share their leading timestamp
	// characters, so their common prefix matches both tasks.
	prefix := commonPrefix(first, second)
	if _, digits := shortNumber(prefix); digits || len(prefix) < 2 {
		t.Skipf("the two ids share no usable prefix (%q, %q)", first, second)
	}

	res := h.run("done", prefix)
	if res.code != 6 {
		t.Fatalf("exit %d, want 6 (stderr %q)", res.code, res.stderr)
	}
}

func commonPrefix(a, b string) string {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return a[:n]
}

func TestGarbageReferenceIsUsageError(t *testing.T) {
	h := newHarness(t)
	res := h.run("show", "not-a-ref")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2 (stderr %q)", res.code, res.stderr)
	}
	if res.stdout != "" {
		t.Fatalf("stdout should stay empty: %q", res.stdout)
	}
}

func TestRemoveWritesTombstone(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Tombstoned", "--json"))
	id := added["id"].(string)

	removed := h.tasksOf(h.mustRun("rm", id[:8], "--json"))
	if removed[0]["deleted_at"] == nil {
		t.Fatalf("rm should stamp deleted_at: %v", removed[0])
	}

	if tasks := h.tasksOf(h.mustRun("ls", "--all", "--json")); len(tasks) != 0 {
		t.Fatalf("ls should hide a tombstone: %v", tasks)
	}
	tasks := h.tasksOf(h.mustRun("ls", "--all", "--deleted", "--json"))
	if len(tasks) != 1 || tasks[0]["id"] != id {
		t.Fatalf("ls --deleted should show the tombstone: %v", tasks)
	}
}

func TestPurgeRefusesWithoutTTYOrYes(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Still here", "--json"))
	id := added["id"].(string)

	res := h.run("rm", id[:8], "--purge")
	if res.code == 0 {
		t.Fatalf("purge without a TTY and without --yes must fail")
	}
	if !strings.Contains(res.stderr, "--yes") {
		t.Fatalf("the refusal should name --yes: %q", res.stderr)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--all", "--json")); len(tasks) != 1 {
		t.Fatalf("nothing may be deleted by a refused purge: %v", tasks)
	}

	purged := h.decode(h.mustRun("rm", id[:8], "--purge", "--yes", "--json"))
	ids, ok := purged["purged"].([]any)
	if !ok || len(ids) != 1 || ids[0] != id {
		t.Fatalf("purged shape: %v", purged)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--all", "--json")); len(tasks) != 0 {
		t.Fatalf("the task should be gone: %v", tasks)
	}
}

func TestEditUnsetAndTagDeduplication(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Editable", "--note", "first", "--set", "client=acme", "--set", "owner=ana", "--json"))
	id := added["id"].(string)

	edited := h.taskOf(h.mustRun("edit", id[:8], "--title", "Edited", "--tag", "ops,Ops,finance", "--tag", "ops", "--unset", "owner", "--json"))
	if edited["title"] != "Edited" {
		t.Fatalf("title: %v", edited["title"])
	}
	if edited["owner"] != nil {
		t.Fatalf("--unset should remove the field: %v", edited["owner"])
	}
	if edited["note"] != "first" {
		t.Fatalf("an untouched note must survive an edit: %v", edited["note"])
	}
	tags, ok := edited["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "finance" || tags[1] != "ops" {
		t.Fatalf("tags should be deduplicated and sorted: %v", edited["tags"])
	}
	if edited["client"] != "acme" {
		t.Fatalf("an untouched user-defined field must survive an edit: %v", edited)
	}

	if res := h.run("edit", id[:8], "--unset", "id"); res.code != 2 {
		t.Fatalf("unsetting a reserved field: exit %d, want 2", res.code)
	}
}

func TestPriorityOutOfRange(t *testing.T) {
	h := newHarness(t)
	for _, value := range []string{"4", "-1"} {
		if res := h.run("add", "Bad priority", "--priority", value); res.code != 2 {
			t.Fatalf("--priority %s: exit %d, want 2 (stderr %q)", value, res.code, res.stderr)
		}
	}
	h.mustRun("add", "Good priority", "--priority", "3")
}

func TestFilters(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Soon", "--due", "2026-11-01", "--priority", "3", "--tag", "finance", "--set", "client=acme")
	h.mustRun("add", "Later", "--due", "2027-01-01", "--priority", "1", "--tag", "ops")

	if tasks := h.tasksOf(h.mustRun("ls", "--tag", "finance", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Soon" {
		t.Fatalf("--tag: %v", tasks)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--due-before", "2026-11-01", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Soon" {
		t.Fatalf("--due-before should include the day itself: %v", tasks)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--priority", "2", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Soon" {
		t.Fatalf("--priority: %v", tasks)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--where", "client=acme", "--json")); len(tasks) != 1 {
		t.Fatalf("--where: %v", tasks)
	}

	// The limit counts matching tasks, not tasks the store looked at.
	if tasks := h.tasksOf(h.mustRun("ls", "--tag", "ops", "--limit", "1", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Later" {
		t.Fatalf("--limit with a condition: %v", tasks)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--limit", "1", "--json")); len(tasks) != 1 {
		t.Fatalf("--limit without a condition: %v", tasks)
	}

	h.mustRun("ls")
	h.mustRun("done", "1")
	if tasks := h.tasksOf(h.mustRun("ls", "--status", "done", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Soon" {
		t.Fatalf("--status done: %v", tasks)
	}
	if tasks := h.tasksOf(h.mustRun("ls", "--all", "--json")); len(tasks) != 2 {
		t.Fatalf("--all: %v", tasks)
	}
	// The default listing is what can be worked on now, so the completed
	// one is gone from it without any flag being passed.
	if tasks := h.tasksOf(h.mustRun("ls", "--json")); len(tasks) != 1 || tasks[0]["title"] != "Later" {
		t.Fatalf("the default listing shows available items: %v", tasks)
	}
	if res := h.run("ls", "--all", "--blocked"); res.code != 2 {
		t.Fatalf("--all with --blocked: exit %d, want 2", res.code)
	}
	if res := h.run("ls", "--sort", "sideways"); res.code != 2 {
		t.Fatalf("bad --sort: exit %d, want 2", res.code)
	}
	h.mustRun("ls", "--sort", "updated")
}

func TestEmptyListingPutsNothingOnStdout(t *testing.T) {
	h := newHarness(t)
	res := h.mustRun("ls")
	if res.stdout != "" {
		t.Fatalf("an empty listing must not write to stdout: %q", res.stdout)
	}
	if !strings.Contains(res.stderr, "tdo add") {
		t.Fatalf("the hint belongs on stderr: %q", res.stderr)
	}
}

func TestErrorEnvelopeGoesToStdoutUnderJSON(t *testing.T) {
	h := newHarness(t)
	res := h.run("show", "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "--json")
	if res.code != 5 {
		t.Fatalf("exit %d, want 5", res.code)
	}
	obj := h.decode(res)
	envelope, ok := obj["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error envelope in %q", res.stdout)
	}
	if envelope["code"] != "not_found" {
		t.Fatalf("code: %v", envelope["code"])
	}
	if envelope["message"] == "" {
		t.Fatalf("message should not be empty: %v", envelope)
	}
}

func TestUsageErrorEnvelopeIsJSONOnly(t *testing.T) {
	h := newHarness(t)
	res := h.run("show", "not-a-ref", "--json")
	if res.code != 2 {
		t.Fatalf("exit %d, want 2", res.code)
	}
	obj := h.decode(res)
	if _, ok := obj["error"]; !ok {
		t.Fatalf("no error envelope in %q", res.stdout)
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Keep me", "--due", "2026-11-01", "--priority", "2", "--tag", "finance", "--note", "pay by card", "--set", "plan={\"owner\":\"ana\"}", "--set", "estimate=3")
	h.mustRun("add", "Finished")
	h.mustRun("ls")
	h.mustRun("done", "2")

	before := h.tasksOf(h.mustRun("ls", "--all", "--json"))
	if len(before) != 2 {
		t.Fatalf("expected two tasks, got %v", before)
	}

	for _, format := range []string{"json", "csv"} {
		t.Run(format, func(t *testing.T) {
			args := []string{"export", "--all"}
			if format == "csv" {
				args = append(args, "--csv")
			}
			exported := h.mustRun(args...)

			if format == "json" {
				obj := h.decode(exported)
				if obj["version"] != float64(1) {
					t.Fatalf("export version: %v", obj["version"])
				}
				if obj["exported_at"] == "" {
					t.Fatalf("exported_at should be set: %v", obj)
				}
			}

			file := filepath.Join(h.dir, "export."+format)
			if err := os.WriteFile(file, []byte(exported.stdout), 0o600); err != nil {
				t.Fatal(err)
			}

			// A second database, so the import is a real migration rather
			// than a no-op over the same rows.
			second := newHarness(t)
			imported := second.decode(second.mustRun("import", file, "--json"))
			if imported["imported"] != float64(2) || imported["skipped"] != float64(0) {
				t.Fatalf("import counts: %v", imported)
			}

			after := second.tasksOf(second.mustRun("ls", "--all", "--json"))
			if len(after) != len(before) {
				t.Fatalf("got %d tasks, want %d", len(after), len(before))
			}
			for i := range before {
				assertSameTask(t, before[i], after[i])
			}

			// Importing the same file again changes nothing.
			again := second.decode(second.mustRun("import", file, "--json"))
			if again["imported"] != float64(0) || again["skipped"] != float64(2) {
				t.Fatalf("re-import counts: %v", again)
			}
		})
	}
}

// assertSameTask compares two task objects key by key, so a user-defined
// field that was dropped or retyped fails the test.
func assertSameTask(t *testing.T, want, got map[string]any) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("different key sets:\n want %v\n got  %v", want, got)
	}
	for key, wantValue := range want {
		gotValue, ok := got[key]
		if !ok {
			t.Fatalf("missing key %q in %v", key, got)
		}
		wantJSON, _ := json.Marshal(wantValue)
		gotJSON, _ := json.Marshal(gotValue)
		if string(wantJSON) != string(gotJSON) {
			t.Fatalf("key %q: got %s, want %s", key, gotJSON, wantJSON)
		}
	}
}

func TestImportAcceptsBareArray(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "From an array", "--set", "project=atlas")
	exported := h.decode(h.mustRun("export", "--all"))
	tasks, _ := json.Marshal(exported["tasks"])

	file := filepath.Join(h.dir, "bare.json")
	if err := os.WriteFile(file, tasks, 0o600); err != nil {
		t.Fatal(err)
	}

	second := newHarness(t)
	imported := second.decode(second.mustRun("import", file, "--json"))
	if imported["imported"] != float64(1) {
		t.Fatalf("import counts: %v", imported)
	}
	if got := second.tasksOf(second.mustRun("ls", "--json"))[0]["project"]; got != "atlas" {
		t.Fatalf("user-defined field after import: %v", got)
	}
}

func TestAdminCommands(t *testing.T) {
	h := newHarness(t)

	version := h.decode(h.mustRun("version", "--json"))
	if version["version"] == "" {
		t.Fatalf("version: %v", version)
	}
	if _, ok := version["commit"]; !ok {
		t.Fatalf("commit key should always be present: %v", version)
	}
	if !strings.HasPrefix(version["go"].(string), "go1") {
		t.Fatalf("go version: %v", version["go"])
	}

	initialized := h.decode(h.mustRun("init", "--json"))
	// The harness already ran init, so this one found the store in place.
	if initialized["initialized"] != true || initialized["provider"] != "sqlite" ||
		initialized["schema_version"] != float64(1) || initialized["created"] != false {
		t.Fatalf("init shape: %v", initialized)
	}

	migrated := h.decode(h.mustRun("migrate", "--json"))
	if migrated["from"] != float64(1) || migrated["to"] != float64(1) || migrated["migrated"] != false {
		t.Fatalf("migrate shape: %v", migrated)
	}

	cfg := h.decode(h.mustRun("config", "--json"))
	if cfg["provider"] != "sqlite" {
		t.Fatalf("config shape: %v", cfg)
	}

	doctor := h.decode(h.mustRun("doctor", "--json"))
	if doctor["ok"] != true {
		t.Fatalf("doctor should pass on a working store: %v", doctor)
	}
	checks, ok := doctor["checks"].([]any)
	if !ok || len(checks) == 0 {
		t.Fatalf("doctor checks: %v", doctor)
	}
	names := make([]string, 0, len(checks))
	for _, raw := range checks {
		c := raw.(map[string]any)
		names = append(names, c["name"].(string))
		if _, ok := c["detail"]; !ok {
			t.Fatalf("check without a detail: %v", c)
		}
	}
	for i, want := range []string{"config", "provider", "provider_cli", "database_directory", "ping", "schema"} {
		if names[i] != want {
			t.Fatalf("check %d is %q, want %q (all: %v)", i, names[i], want, names)
		}
	}
}

func TestDoctorFailsOnAnUninitializedStore(t *testing.T) {
	h := newHarness(t)
	h.env["TODOCLOUD_SQLITE_PATH"] = filepath.Join(h.dir, "empty.db")

	res := h.run("doctor", "--json")
	if res.code == 0 {
		t.Fatalf("doctor should fail on an uninitialized store")
	}
	obj := h.decode(res)
	if obj["ok"] != false {
		t.Fatalf("doctor shape: %v", obj)
	}
	if _, ok := obj["error"]; ok {
		t.Fatalf("doctor reports through its own shape, not the error envelope: %v", obj)
	}
}

func TestUnimplementedProviderIsAConfigError(t *testing.T) {
	h := newHarness(t)
	res := h.run("ls", "--provider", "firestore", "--json")
	if res.code != 3 {
		t.Fatalf("exit %d, want 3 (stderr %q)", res.code, res.stderr)
	}
	obj := h.decode(res)
	envelope := obj["error"].(map[string]any)
	if envelope["code"] != "config" {
		t.Fatalf("code: %v", envelope["code"])
	}
}

// TestEveryJSONCommandWritesOnlyJSON walks the whole command surface and
// asserts the output contract: exactly one JSON value on stdout and nothing
// else, so `tdo … --json | jq` is safe everywhere.
func TestEveryJSONCommandWritesOnlyJSON(t *testing.T) {
	h := newHarness(t)
	added := h.taskOf(h.mustRun("add", "Contract", "--json"))
	id := added["id"].(string)
	h.mustRun("ls")

	exportFile := filepath.Join(h.dir, "contract.json")
	if err := os.WriteFile(exportFile, []byte(h.mustRun("export", "--all").stdout), 0o600); err != nil {
		t.Fatal(err)
	}

	commands := [][]string{
		{"add", "Another", "--json"},
		{"ls", "--json"},
		{"ls", "--all", "--deleted", "--json"},
		{"show", id, "--json"},
		{"done", id, "--json"},
		{"undone", id, "--json"},
		{"edit", id, "--title", "Contract II", "--json"},
		{"init", "--json"},
		{"migrate", "--json"},
		{"config", "--json"},
		{"doctor", "--json"},
		{"version", "--json"},
		{"export", "--all", "--json"},
		{"import", exportFile, "--json"},
		{"rm", id, "--json"},
		{"rm", id, "--purge", "--yes", "--json"},
		// Failures are part of the contract too.
		{"show", "not-a-ref", "--json"},
		{"show", "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "--json"},
	}
	for _, args := range commands {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			res := h.run(args...)
			var v any
			dec := json.NewDecoder(strings.NewReader(res.stdout))
			if err := dec.Decode(&v); err != nil {
				t.Fatalf("stdout is not JSON: %q: %v", res.stdout, err)
			}
			if dec.More() {
				t.Fatalf("more than one JSON value on stdout: %q", res.stdout)
			}
		})
	}
}

// TestNoTokenFlagExists guards the rule that a secret may never be accepted
// on the command line, where ps and shell history can see it.
func TestNoTokenFlagExists(t *testing.T) {
	h := newHarness(t)
	for _, args := range [][]string{
		{"ls", "--token", "whatever"},
		{"add", "x", "--token", "whatever"},
		{"config", "--token", "whatever"},
	} {
		if res := h.run(args...); res.code == 0 {
			t.Fatalf("tdo %s was accepted; there must be no --token flag", strings.Join(args, " "))
		}
	}
}

// TestCorruptShortRefCacheIsNotFatal checks that a damaged cache degrades to a
// plain not-found rather than taking the process down.
func TestCorruptShortRefCacheIsNotFatal(t *testing.T) {
	h := newHarness(t)
	h.mustRun("add", "Cached")
	h.mustRun("ls")

	cache := filepath.Join(h.env["TODOCLOUD_STATE_DIR"], "lastlist.json")
	if err := os.WriteFile(cache, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	res := h.run("done", "1")
	if res.code != 5 {
		t.Fatalf("exit %d, want 5 (stderr %q)", res.code, res.stderr)
	}
	// The id prefix path still works.
	tasks := h.tasksOf(h.mustRun("ls", "--json"))
	h.mustRun("done", tasks[0]["id"].(string)[:8])
}

// TestCommandsNeverCreateTheStore is the regression test for a read-only
// command that used to leave a directory tree and an empty database behind
// when the configured path was a typo. Only `tdo init` may create a store.
func TestCommandsNeverCreateTheStore(t *testing.T) {
	cases := [][]string{
		{"ls"},
		{"show", "01J3ABCDEFGHJKMNPQRSTVWXYZ"},
		{"add", "a task"},
		{"done", "01J3ABCDEFGHJKMNPQRSTVWXYZ"},
		{"export"},
		{"import"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			h := newHarness(t)
			stray := filepath.Join(h.dir, "stray")
			db := filepath.Join(stray, "tasks.db")
			h.env["TODOCLOUD_SQLITE_PATH"] = db

			res := h.run(args...)
			if res.code != 3 {
				t.Errorf("tdo %s: exit %d, want 3\nstdout: %s\nstderr: %s",
					strings.Join(args, " "), res.code, res.stdout, res.stderr)
			}
			if !strings.Contains(res.stderr, "tdo init") {
				t.Errorf("stderr should advise `tdo init`: %q", res.stderr)
			}
			if strings.Contains(res.stderr, "no such table") {
				t.Errorf("stderr leaks the driver message: %q", res.stderr)
			}
			if _, err := os.Stat(db); !os.IsNotExist(err) {
				t.Errorf("database file created: stat err = %v", err)
			}
			if _, err := os.Stat(stray); !os.IsNotExist(err) {
				t.Errorf("parent directory created: stat err = %v", err)
			}
		})
	}
}

func TestInitReportsWhetherItCreatedTheStore(t *testing.T) {
	h := newHarness(t)
	h.env["TODOCLOUD_SQLITE_PATH"] = filepath.Join(h.dir, "fresh", "tasks.db")

	first := h.decode(h.mustRun("init", "--json"))
	if first["created"] != true || first["initialized"] != true ||
		first["provider"] != "sqlite" || first["schema_version"] != float64(1) {
		t.Fatalf("first init shape: %v", first)
	}

	second := h.decode(h.mustRun("init", "--json"))
	if second["created"] != false || second["initialized"] != true ||
		second["provider"] != "sqlite" || second["schema_version"] != float64(1) {
		t.Fatalf("second init shape: %v", second)
	}
}

func TestInitHumanOutputDistinguishesCreationFromReuse(t *testing.T) {
	h := newHarness(t)
	db := filepath.Join(h.dir, "human", "tasks.db")
	h.env["TODOCLOUD_SQLITE_PATH"] = db

	created := h.mustRun("init")
	if want := "created sqlite: " + db + " at schema version 1\n"; created.stdout != want {
		t.Errorf("first init stdout = %q, want %q", created.stdout, want)
	}

	again := h.mustRun("init")
	if want := "sqlite: " + db + " is already initialized at schema version 1\n"; again.stdout != want {
		t.Errorf("second init stdout = %q, want %q", again.stdout, want)
	}
}
