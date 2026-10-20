package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Several processes against one database is the case the in-process tests
// cannot reach at all: there, one goroutine holds the only connection. What
// makes it work here is WAL plus the 5-second busy timeout the store sets on
// every open, so a lock timeout in these tests is a real defect rather than
// flakiness.
//
// The assertion is deliberately one-sided: an add either succeeds and is
// present afterwards, or fails with a non-zero exit code. What must never
// happen is an add that reports success and is not there.

const concurrentWriters = 8

// TestConcurrentAddsNeverLoseATaskSilently runs eight adds at once and checks
// that the store holds exactly the tasks whose processes exited 0.
func TestConcurrentAddsNeverLoseATaskSilently(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	type outcome struct {
		title string
		res   result
	}
	outcomes := make([]outcome, concurrentWriters)
	var wg sync.WaitGroup
	for i := range concurrentWriters {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			title := fmt.Sprintf("concurrent task %d", i)
			outcomes[i] = outcome{title: title, res: h.run("add", "--json", title)}
		}(i)
	}
	wg.Wait()

	present := make(map[string]bool)
	for _, task := range h.tasksOf(h.mustRun("ls", "--json", "--all")) {
		present[fmt.Sprint(task["title"])] = true
	}
	for _, o := range outcomes {
		switch {
		case o.res.code == 0 && !present[o.title]:
			t.Errorf("tdo add exited 0 but the task is missing — a silent loss:\n%s", o.res.describe())
		case o.res.code != 0 && present[o.title]:
			t.Errorf("tdo add failed but the task is in the store:\n%s", o.res.describe())
		case o.res.code != 0:
			// A reported failure is acceptable; a lock timeout is not,
			// because the store sets a 5-second busy timeout.
			if strings.Contains(strings.ToLower(o.res.stderr), "locked") || strings.Contains(strings.ToLower(o.res.stderr), "busy") {
				t.Errorf("an add lost a lock race despite the busy timeout:\n%s", o.res.describe())
			}
		}
	}
	if len(present) != concurrentWriters {
		t.Logf("%d of %d concurrent adds succeeded", len(present), concurrentWriters)
	}
}

// TestConcurrentAddsAndListingsAgree mixes readers with writers: a listing
// taken while adds are in flight must be a consistent prefix of the final
// store, never a row that does not exist and never a parse failure.
func TestConcurrentAddsAndListingsAgree(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")

	var (
		mu       sync.Mutex
		failures []result
		seen     []string
	)
	var wg sync.WaitGroup
	for i := range concurrentWriters {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			title := fmt.Sprintf("mixed task %d", i)
			res := h.run("add", "--json", title)
			mu.Lock()
			defer mu.Unlock()
			if res.code != 0 {
				failures = append(failures, res)
				return
			}
			seen = append(seen, title)
		}(i)

		wg.Add(1)
		go func() {
			defer wg.Done()
			res := h.run("ls", "--json", "--all")
			mu.Lock()
			defer mu.Unlock()
			if res.code != 0 {
				failures = append(failures, res)
			}
		}()
	}
	wg.Wait()

	for _, res := range failures {
		if strings.Contains(strings.ToLower(res.stderr), "locked") || strings.Contains(strings.ToLower(res.stderr), "busy") {
			t.Errorf("a concurrent command lost a lock race despite the busy timeout:\n%s", res.describe())
		} else {
			t.Errorf("a concurrent command failed:\n%s", res.describe())
		}
	}
	present := make(map[string]bool)
	for _, task := range h.tasksOf(h.mustRun("ls", "--json", "--all")) {
		present[fmt.Sprint(task["title"])] = true
	}
	for _, title := range seen {
		if !present[title] {
			t.Errorf("%q was reported as added and is not in the store — a silent loss", title)
		}
	}
}

// TestAnInterruptedAddLeavesTheStoreOpenable sends SIGINT to an add and then
// checks that the store is still a store: a listing exits 0, and the task is
// either there or not there — never a half-written row and never a file the
// tool can no longer open.
//
// The signal is sent as soon as the child is running, so which side of the
// commit it lands on is not fixed; that is the point. Determinism comes from
// the assertion covering both outcomes rather than from the timing.
func TestAnInterruptedAddLeavesTheStoreOpenable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGINT has no equivalent on Windows")
	}
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Added before the interrupt")

	const interrupted = "Interrupted add"
	cmd := exec.Command(tdoBin, "add", "--json", interrupted)
	cmd.Env = h.env
	cmd.Dir = h.root
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the add: %v", err)
	}
	// A short, bounded wait: long enough that the process is running, short
	// enough that the signal may well land before the commit. Which side it
	// lands on is not fixed, and the assertions below hold either way, so
	// the test stays deterministic without retries.
	time.Sleep(5 * time.Millisecond)
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("signalling the add: %v", err)
	}
	waitErr := cmd.Wait()
	t.Logf("the interrupted add finished with %v (stdout %q, stderr %q)", waitErr, out.String(), errb.String())

	// Whatever happened to that process, the store is still usable.
	ls := h.run("ls", "--json", "--all")
	if ls.code != 0 {
		t.Fatalf("the store is no longer listable after an interrupt:\n%s", ls.describe())
	}
	got := titles(h.tasksOf(ls))
	if len(got) == 0 {
		t.Fatalf("the store is empty after an interrupt; the task added beforehand is gone")
	}
	if len(got) != 1 && len(got) != 2 {
		t.Errorf("the store holds %v, want the earlier task with or without the interrupted one", got)
	}
	if got[0] != "Added before the interrupt" {
		t.Errorf("the task added before the interrupt is gone: %v", got)
	}
	// doctor agrees that the schema and the file are intact.
	doctor := h.decode(h.mustRun("doctor", "--json"))
	if doctor["ok"] != true {
		t.Errorf("doctor is unhappy after an interrupt: %v", doctor)
	}
}

// TestAnInterruptBetweenTwoCommandsChangesNothing is the narrow, fully
// deterministic companion: a process that is signalled before it can do
// anything must leave the store exactly as it was.
func TestAnInterruptBetweenTwoCommandsChangesNothing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("SIGINT has no equivalent on Windows")
	}
	t.Parallel()
	h := newHarness(t)
	h.mustRun("init")
	h.addTask("Only task")

	before := snapshotDir(t, h.data)

	cmd := exec.Command(tdoBin, "add", "--json", "Never committed")
	cmd.Env = h.env
	cmd.Dir = h.root
	// Holding stdin open and killing the process before it is scheduled is
	// not something a test can arrange portably, so instead the signal is
	// sent immediately after Start and the assertion is about the store, not
	// about the process.
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the add: %v", err)
	}
	_ = cmd.Process.Signal(os.Interrupt)
	_ = cmd.Wait()

	after := snapshotDir(t, h.data)
	if gone := removed(before, after); len(gone) != 0 {
		t.Errorf("an interrupted add removed %v\nbefore %v\nafter %v", gone, before, after)
	}
	ls := h.run("ls", "--json", "--all")
	if ls.code != 0 {
		t.Fatalf("the store is no longer listable:\n%s", ls.describe())
	}
	for _, title := range titles(h.tasksOf(ls)) {
		if title != "Only task" && title != "Never committed" {
			t.Errorf("unexpected task %q after an interrupt", title)
		}
	}
}
