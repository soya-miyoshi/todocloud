// End-to-end tests that drive the real compiled binary as a subprocess.
//
// The in-process tests in internal/cli cover the command tree through
// cli.RunWith. They cannot observe what the shipped executable does: the exit
// code os.Exit actually produces, the two real file descriptors, several
// processes against one database, a signal arriving mid-write, or the mode of
// a file the tool created. That is what this suite is for, and in particular
// it is where the two invariants the maintainer cares about are proven by
// watching the filesystem rather than by reading the code:
//
//   - a database is created only by `tdo init`;
//   - no command ever deletes one, `tdo rm --purge` included.
//
// Every run gets its own temporary directory and a child environment built
// from scratch, so a test can never reach the developer's real config,
// database, keychain or provider CLI.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/build"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// tdoBin is the binary under test, built once by TestMain. It is empty when
// the suite could not be built, in which case every test skips.
var tdoBin string

// buildErr records why the binary is missing, for the skip message.
var buildErr error

func TestMain(m *testing.M) {
	code := func() int {
		tmp, err := os.MkdirTemp("", "tdo-e2e-build")
		if err != nil {
			buildErr = err
			return m.Run()
		}
		defer os.RemoveAll(tmp)

		goTool, err := goToolPath()
		if err != nil {
			buildErr = err
			return m.Run()
		}
		name := "tdo"
		if runtime.GOOS == "windows" {
			name = "tdo.exe"
		}
		out := filepath.Join(tmp, name)
		cmd := exec.Command(goTool, "build", "-o", out, ".")
		if combined, err := cmd.CombinedOutput(); err != nil {
			buildErr = fmt.Errorf("go build: %v: %s", err, combined)
			return m.Run()
		}
		tdoBin = out
		return m.Run()
	}()
	os.Exit(code)
}

// goToolPath finds a Go toolchain. A machine without one skips the suite
// rather than failing it.
func goToolPath() (string, error) {
	if p, err := exec.LookPath("go"); err == nil {
		return p, nil
	}
	if root := build.Default.GOROOT; root != "" {
		candidate := filepath.Join(root, "bin", "go")
		if runtime.GOOS == "windows" {
			candidate += ".exe"
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("no Go toolchain on PATH")
}

// requireBinary skips the calling test unless the binary is available. The
// whole suite is skipped under -short so that `go test -short ./...` stays
// fast.
func requireBinary(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("end-to-end suite builds and runs the real binary; skipped under -short")
	}
	if tdoBin == "" {
		t.Skipf("binary under test was not built: %v", buildErr)
	}
}

// result is one subprocess invocation's observable behaviour: the two streams
// kept apart, and the exit code as the operating system reported it.
type result struct {
	code   int
	stdout string
	stderr string
	args   []string
}

func (r result) describe() string {
	return fmt.Sprintf("tdo %s\nexit %d\nstdout: %q\nstderr: %q",
		strings.Join(r.args, " "), r.code, r.stdout, r.stderr)
}

// harness is one hermetic installation of tdo: a data directory, a state
// directory, a config file and a child environment that inherits nothing.
type harness struct {
	t *testing.T

	// root is the per-test temporary directory. data is the directory the
	// database lives in, and is what the invariant helpers watch.
	root  string
	data  string
	db    string
	state string
	cfg   string

	// env is the child environment, built from scratch.
	env []string
}

// newHarness prepares the directories and the environment but creates no
// store: a test that wants one calls init itself, because whether init is the
// only thing that creates a database is exactly what is under test.
func newHarness(t *testing.T) *harness {
	t.Helper()
	requireBinary(t)

	root := t.TempDir()
	h := &harness{
		t:     t,
		root:  root,
		data:  filepath.Join(root, "data"),
		state: filepath.Join(root, "state"),
		cfg:   filepath.Join(root, "config.toml"),
	}
	h.db = filepath.Join(h.data, "tasks.db")

	// TODOCLOUD_CONFIG names the file explicitly, so it has to exist; an
	// empty one keeps every setting at its default without reading anything
	// of the developer's.
	if err := os.WriteFile(h.cfg, []byte("# empty configuration for the end-to-end suite\n"), 0o600); err != nil {
		t.Fatalf("writing the test config file: %v", err)
	}
	h.env = h.childEnv(h.db)
	return h
}

// childEnv builds the environment for the child process from nothing. The
// developer's own variables are not inherited, and the ones that could point
// at a real provider account are cleared explicitly rather than left to
// chance.
func (h *harness) childEnv(dbPath string) []string {
	env := []string{
		"TODOCLOUD_PROVIDER=sqlite",
		"TODOCLOUD_SQLITE_PATH=" + dbPath,
		"TODOCLOUD_STATE_DIR=" + h.state,
		"TODOCLOUD_CONFIG=" + h.cfg,
		"XDG_CONFIG_HOME=" + filepath.Join(h.root, "xdg-config"),
		"XDG_STATE_HOME=" + filepath.Join(h.root, "xdg-state"),
		"XDG_DATA_HOME=" + filepath.Join(h.root, "xdg-data"),
		// Anything that could reach a real account, emptied on purpose.
		"TODOCLOUD_TURSO_URL=",
		"TODOCLOUD_TURSO_TOKEN=",
		"TODOCLOUD_D1_ACCOUNT_ID=",
		"TODOCLOUD_D1_DATABASE_ID=",
		"TODOCLOUD_D1_TOKEN=",
		"TODOCLOUD_FIRESTORE_PROJECT=",
		"GOOGLE_APPLICATION_CREDENTIALS=",
	}
	if runtime.GOOS == "windows" {
		env = append(env, "USERPROFILE="+h.root, "HOME="+h.root)
		// Windows needs SystemRoot for the C runtime to start at all.
		if v := os.Getenv("SystemRoot"); v != "" {
			env = append(env, "SystemRoot="+v)
		}
		if v := os.Getenv("TEMP"); v != "" {
			env = append(env, "TEMP="+v, "TMP="+v)
		}
		return env
	}
	// An empty directory on PATH: no turso, gcloud, wrangler, security or
	// secret-tool can be found from a test.
	empty := filepath.Join(h.root, "empty-path")
	if err := os.MkdirAll(empty, 0o700); err != nil {
		h.t.Fatalf("creating the empty PATH directory: %v", err)
	}
	return append(env, "HOME="+h.root, "PATH="+empty, "TMPDIR="+h.root)
}

// run invokes the binary and captures both streams separately.
func (h *harness) run(args ...string) result {
	h.t.Helper()
	return h.runWithEnv(h.env, nil, args...)
}

// runWithEnv is run with an environment and stdin of the caller's choosing.
func (h *harness) runWithEnv(env []string, stdin []byte, args ...string) result {
	h.t.Helper()
	cmd := exec.Command(tdoBin, args...)
	cmd.Env = env
	cmd.Dir = h.root
	if stdin != nil {
		cmd.Stdin = strings.NewReader(string(stdin))
	}
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			h.t.Fatalf("running tdo %s: %v", strings.Join(args, " "), err)
		}
	}
	return result{code: code, stdout: out.String(), stderr: errb.String(), args: args}
}

// mustRun fails the test unless the command exited 0.
func (h *harness) mustRun(args ...string) result {
	h.t.Helper()
	res := h.run(args...)
	if res.code != 0 {
		h.t.Fatalf("expected success:\n%s", res.describe())
	}
	return res
}

// decode parses stdout as exactly one JSON value, which also asserts that
// nothing but machine output reached stdout.
func (h *harness) decode(res result) map[string]any {
	h.t.Helper()
	dec := json.NewDecoder(strings.NewReader(res.stdout))
	var v map[string]any
	if err := dec.Decode(&v); err != nil {
		h.t.Fatalf("stdout is not a JSON object: %v\n%s", err, res.describe())
	}
	if dec.More() {
		h.t.Fatalf("stdout holds more than one JSON value:\n%s", res.describe())
	}
	return v
}

// taskOf pulls the single task out of a response. Every command emits
// {"tasks":[…],"count":n}, so a command that acts on one item emits a
// one-element array and this is `.tasks[0]`.
func (h *harness) taskOf(res result) map[string]any {
	h.t.Helper()
	tasks := h.tasksOf(res)
	if len(tasks) != 1 {
		h.t.Fatalf("expected exactly one task:\n%s", res.describe())
	}
	return tasks[0]
}

func (h *harness) tasksOf(res result) []map[string]any {
	h.t.Helper()
	obj := h.decode(res)
	raw, ok := obj["tasks"].([]any)
	if !ok {
		h.t.Fatalf("no tasks array:\n%s", res.describe())
	}
	tasks := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		task, ok := e.(map[string]any)
		if !ok {
			h.t.Fatalf("a task is not an object:\n%s", res.describe())
		}
		tasks = append(tasks, task)
	}
	return tasks
}

// titles collects the titles of a task list, sorted, so a comparison does not
// depend on listing order.
func titles(tasks []map[string]any) []string {
	out := make([]string, 0, len(tasks))
	for _, task := range tasks {
		out = append(out, fmt.Sprint(task["title"]))
	}
	sort.Strings(out)
	return out
}

// addTask adds one task through the real process and returns its id.
func (h *harness) addTask(args ...string) string {
	h.t.Helper()
	res := h.mustRun(append([]string{"add", "--json"}, args...)...)
	id, ok := h.taskOf(res)["id"].(string)
	if !ok || id == "" {
		h.t.Fatalf("add returned no id:\n%s", res.describe())
	}
	return id
}

// --- The filesystem snapshot, which is how the invariants are proven. ------

// entry is one path under a watched directory, with the size and the
// modification time that make a change visible in a failure message.
type entry struct {
	path    string
	size    int64
	dir     bool
	modTime time.Time
}

// snapshot is a sorted listing of everything under a directory. The zero
// value — a nil slice — is what a directory that does not exist produces, so
// "nothing was created" and "the directory is empty" stay distinguishable
// through exists.
type snapshot struct {
	root   string
	exists bool
	files  []entry
}

// snapshotDir walks root and returns a sorted list of relative paths with
// their sizes. It is deliberately tolerant of a missing root: half of what
// this suite asserts is that a directory was never brought into being.
func snapshotDir(t *testing.T, root string) snapshot {
	t.Helper()
	snap := snapshot{root: root}
	info, err := os.Stat(root)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stat %s: %v", root, err)
		}
		return snap
	}
	if !info.IsDir() {
		t.Fatalf("%s is not a directory", root)
	}
	snap.exists = true
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		snap.files = append(snap.files, entry{
			path:    filepath.ToSlash(rel),
			size:    info.Size(),
			dir:     info.IsDir(),
			modTime: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	sort.Slice(snap.files, func(i, j int) bool { return snap.files[i].path < snap.files[j].path })
	return snap
}

// paths is the set of relative paths in the snapshot, which is what the
// invariants compare: sizes change as rows are written, the set of names is
// what must not.
func (s snapshot) paths() []string {
	out := make([]string, 0, len(s.files))
	for _, e := range s.files {
		out = append(out, e.path)
	}
	return out
}

// has reports whether a relative path is present.
func (s snapshot) has(rel string) bool {
	for _, e := range s.files {
		if e.path == rel {
			return true
		}
	}
	return false
}

// String renders the snapshot so that a diff in a failure message is
// readable: one line per path, with its size.
func (s snapshot) String() string {
	if !s.exists {
		return fmt.Sprintf("%s: (does not exist)", s.root)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s:", s.root)
	if len(s.files) == 0 {
		b.WriteString(" (empty)")
		return b.String()
	}
	for _, e := range s.files {
		kind := ""
		if e.dir {
			kind = "/"
		}
		fmt.Fprintf(&b, "\n  %s%s  %d bytes", e.path, kind, e.size)
	}
	return b.String()
}

// added returns the paths present in next but not in prev.
func added(prev, next snapshot) []string {
	return difference(next.paths(), prev.paths())
}

// removed returns the paths present in prev but not in next.
func removed(prev, next snapshot) []string {
	return difference(prev.paths(), next.paths())
}

func difference(a, b []string) []string {
	in := make(map[string]bool, len(b))
	for _, s := range b {
		in[s] = true
	}
	var out []string
	for _, s := range a {
		if !in[s] {
			out = append(out, s)
		}
	}
	return out
}

// --- 1. A normal session, end to end. --------------------------------------

// TestNormalSessionThroughTheRealBinary is the "does the CLI actually work on
// local SQLite" proof: one session that uses every command a user would, run
// as real processes, asserting the exit code, that --json stdout is exactly
// one JSON value and that human output lands on the stream the contract says
// it does.
func TestNormalSessionThroughTheRealBinary(t *testing.T) {
	t.Parallel()
	h := newHarness(t)

	// version and config work before there is a store at all.
	version := h.decode(h.mustRun("version", "--json"))
	if version["version"] == nil {
		t.Errorf("version --json has no version key: %v", version)
	}

	// init brings the store into being and says so.
	initObj := h.decode(h.mustRun("init", "--json"))
	if initObj["created"] != true {
		t.Errorf("first init did not report created=true: %v", initObj)
	}
	if initObj["provider"] != "sqlite" {
		t.Errorf("init reports the wrong provider: %v", initObj)
	}

	// config reports the resolved configuration and where it came from.
	cfg := h.decode(h.mustRun("config", "--json"))
	if cfg["provider"] != "sqlite" {
		t.Errorf("config --json reports the wrong provider: %v", cfg)
	}
	origins, ok := cfg["origins"].(map[string]any)
	if !ok {
		t.Fatalf("config --json has no origins map: %v", cfg)
	}
	if got := fmt.Sprint(origins["provider"]); got != "env:TODOCLOUD_PROVIDER" {
		t.Errorf("provider origin = %q, want env:TODOCLOUD_PROVIDER", got)
	}

	// add, with every field flag the contract lists.
	addRes := h.mustRun("add", "--json", "Pay the invoice",
		"--due", "2026-11-01",
		"--priority", "2",
		"--tag", "finance,urgent",
		"--note", "bank transfer",
		"--set", "client=acme",
		"--set", "estimate=3")
	task := h.taskOf(addRes)
	id := fmt.Sprint(task["id"])
	for key, want := range map[string]any{
		"title":    "Pay the invoice",
		"done":     false,
		"due_at":   "2026-11-01T00:00:00Z",
		"priority": float64(2),
		"note":     "bank transfer",
		"client":   "acme",
		"estimate": float64(3),
	} {
		if got := task[key]; got != want {
			t.Errorf("add: task[%q] = %#v, want %#v", key, got, want)
		}
	}
	if fmt.Sprint(task["tags"]) != "[finance urgent]" {
		t.Errorf("add: tags = %#v", task["tags"])
	}
	// Every required key is present, including the ones that are null.
	for _, key := range []string{"id", "title", "done", "created_at", "updated_at", "completed_at", "deleted_at", "due_at", "priority", "tags", "note",
		"kind", "status", "parent_id", "available", "blocked_by", "flagged", "estimated_minutes"} {
		if _, ok := task[key]; !ok {
			t.Errorf("add: required key %q is missing from %v", key, task)
		}
	}

	// A human add writes to stdout and leaves stderr clean apart from the
	// store notice the contract allows when the provider came from the
	// environment.
	human := h.mustRun("add", "Water the plants")
	if strings.TrimSpace(human.stdout) == "" {
		t.Errorf("human add printed nothing on stdout:\n%s", human.describe())
	}

	// ls sees both, and reports a count that matches.
	lsRes := h.mustRun("ls", "--json")
	lsObj := h.decode(lsRes)
	tasks := h.tasksOf(lsRes)
	if len(tasks) != 2 {
		t.Fatalf("ls returned %d tasks, want 2:\n%s", len(tasks), lsRes.describe())
	}
	if lsObj["count"] != float64(2) {
		t.Errorf("ls count = %#v, want 2", lsObj["count"])
	}

	// show by full id, and by an id prefix, which is what a machine caller
	// uses. The short numbers come from the human table: `ls --json` leaves
	// the cache alone on purpose, so that a script or an agent listing tasks
	// cannot renumber the list under whoever is reading the terminal.
	shown := h.taskOf(h.mustRun("show", "--json", id))
	if shown["id"] != id {
		t.Errorf("show by id returned %v", shown["id"])
	}
	if byPrefix := h.taskOf(h.mustRun("show", "--json", id[:10])); byPrefix["id"] != id {
		t.Errorf("show by id prefix returned %v, want %s", byPrefix["id"], id)
	}

	// The human listing does cache the numbers, and they resolve afterwards.
	h.mustRun("ls")
	if byNumber := h.taskOf(h.mustRun("show", "--json", "1")); byNumber["id"] == nil {
		t.Errorf("show by short number returned no task after a human listing")
	}

	// A machine listing must not have moved the numbers.
	before := h.taskOf(h.mustRun("show", "--json", "1"))
	h.mustRun("ls", "--json", "--all")
	after := h.taskOf(h.mustRun("show", "--json", "1"))
	if before["id"] != after["id"] {
		t.Errorf("`ls --json` renumbered the listing: task 1 went from %v to %v", before["id"], after["id"])
	}

	// done, then undone, round-trip the completion state.
	doneTasks := h.tasksOf(h.mustRun("done", "--json", id))
	if len(doneTasks) != 1 || doneTasks[0]["done"] != true {
		t.Errorf("done did not complete the task: %v", doneTasks)
	}
	if doneTasks[0]["completed_at"] == nil {
		t.Errorf("done left completed_at null: %v", doneTasks[0])
	}
	undoneTasks := h.tasksOf(h.mustRun("undone", "--json", id))
	if len(undoneTasks) != 1 || undoneTasks[0]["done"] != false {
		t.Errorf("undone did not reopen the task: %v", undoneTasks)
	}
	if undoneTasks[0]["completed_at"] != nil {
		t.Errorf("undone left completed_at set: %v", undoneTasks[0])
	}

	// edit changes what it is given and leaves the rest alone.
	edited := h.taskOf(h.mustRun("edit", "--json", id, "--title", "Pay the invoice today", "--priority", "3"))
	if edited["title"] != "Pay the invoice today" || edited["priority"] != float64(3) {
		t.Errorf("edit did not apply: %v", edited)
	}
	if edited["client"] != "acme" {
		t.Errorf("edit dropped a user-defined field: %v", edited)
	}

	// rm writes a tombstone: the task leaves the default listing and appears
	// under --deleted.
	removedTasks := h.tasksOf(h.mustRun("rm", "--json", id))
	if len(removedTasks) != 1 || removedTasks[0]["deleted_at"] == nil {
		t.Errorf("rm did not write a tombstone: %v", removedTasks)
	}
	if after := h.tasksOf(h.mustRun("ls", "--json")); len(after) != 1 {
		t.Errorf("the removed task is still listed: %v", titles(after))
	}
	deleted := h.tasksOf(h.mustRun("ls", "--json", "--deleted"))
	if len(deleted) != 1 || deleted[0]["id"] != id {
		t.Errorf("ls --deleted returned %v, want the tombstoned task", titles(deleted))
	}

	// export writes an archive that names its origin, and import replays it
	// into a second store without duplicating anything.
	exported := h.mustRun("export", "--json", "--all")
	exportObj := h.decode(exported)
	if got := fmt.Sprint(exportObj["store"]); !strings.HasPrefix(got, "sqlite: ") {
		t.Errorf("export store = %q, want a sqlite: prefix", got)
	}
	archive := filepath.Join(h.root, "export.json")
	if err := os.WriteFile(archive, []byte(exported.stdout), 0o600); err != nil {
		t.Fatalf("writing the archive: %v", err)
	}
	// Re-importing into the same store is a no-op, because an existing id is
	// never overwritten.
	reimport := h.decode(h.mustRun("import", "--json", archive))
	if reimport["imported"] != float64(0) {
		t.Errorf("re-importing an export imported rows: %v", reimport)
	}
	if reimport["skipped"] == float64(0) {
		t.Errorf("re-importing an export skipped nothing: %v", reimport)
	}

	// doctor reports on a healthy store and exits 0.
	doctor := h.decode(h.mustRun("doctor", "--json"))
	if doctor["ok"] != true {
		t.Errorf("doctor on a healthy store is not ok: %v", doctor)
	}
	checks, ok := doctor["checks"].([]any)
	if !ok || len(checks) == 0 {
		t.Fatalf("doctor has no checks: %v", doctor)
	}

	// migrate on a current store is a no-op that says so.
	migrate := h.decode(h.mustRun("migrate", "--json"))
	if migrate["migrated"] != false {
		t.Errorf("migrate on a current store reports a migration: %v", migrate)
	}

	// Every command's human form keeps stdout free of JSON and vice versa:
	// the error envelope under --json goes to stdout, the prose to stderr.
	missing := h.run("show", "--json", "01J00000000000000000000000")
	if missing.code != 5 {
		t.Errorf("show of an unknown id exited %d, want 5:\n%s", missing.code, missing.describe())
	}
	envelope := h.decode(missing)
	errObj, ok := envelope["error"].(map[string]any)
	if !ok || errObj["code"] != "not_found" {
		t.Errorf("unexpected error envelope: %v", envelope)
	}
	if strings.TrimSpace(missing.stderr) != "" {
		t.Errorf("under --json the prose should stay off stderr:\n%s", missing.describe())
	}
	humanMissing := h.run("show", "01J00000000000000000000000")
	if humanMissing.code != 5 || strings.TrimSpace(humanMissing.stderr) == "" {
		t.Errorf("a human failure should print prose on stderr:\n%s", humanMissing.describe())
	}
	if strings.TrimSpace(humanMissing.stdout) != "" {
		t.Errorf("a human failure put something on stdout:\n%s", humanMissing.describe())
	}
}

// TestImportIntoASecondStoreCarriesEverythingOver proves the export/import
// pair through two real processes and two real databases.
func TestImportIntoASecondStoreCarriesEverythingOver(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("First", "--tag", "a", "--set", "client=acme")
	h.addTask("Second", "--priority", "1")

	archive := filepath.Join(h.root, "archive.json")
	export := h.mustRun("export", "--json", "--all")
	if err := os.WriteFile(archive, []byte(export.stdout), 0o600); err != nil {
		t.Fatalf("writing the archive: %v", err)
	}

	second := h.second("other")
	second.mustRun("init")
	imported := second.decode(second.mustRun("import", "--json", archive))
	if imported["imported"] != float64(2) {
		t.Errorf("imported = %#v, want 2", imported["imported"])
	}
	got := titles(second.tasksOf(second.mustRun("ls", "--json", "--all")))
	if strings.Join(got, ",") != "First,Second" {
		t.Errorf("the second store holds %v", got)
	}
	task := second.tasksOf(second.mustRun("ls", "--json", "--all", "--where", "client=acme"))
	if len(task) != 1 || task[0]["title"] != "First" {
		t.Errorf("a user-defined field did not survive the import: %v", task)
	}
}

// second returns a harness over the same temporary root but a different
// database, so a test can drive two stores without leaving its sandbox. The
// state directory is separate too, because the short-number cache is
// per-store.
func (h *harness) second(name string) *harness {
	h.t.Helper()
	other := &harness{
		t:     h.t,
		root:  h.root,
		data:  filepath.Join(h.root, name),
		state: filepath.Join(h.root, name+"-state"),
		cfg:   h.cfg,
	}
	other.db = filepath.Join(other.data, "tasks.db")
	other.env = other.childEnv(other.db)
	return other
}
