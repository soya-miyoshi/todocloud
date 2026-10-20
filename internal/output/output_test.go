package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

func newPrinter() (Printer, *bytes.Buffer, *bytes.Buffer) {
	var out, err bytes.Buffer
	return Printer{Out: &out, Err: &err}, &out, &err
}

func TestEmitWritesOneJSONLine(t *testing.T) {
	p, out, errb := newPrinter()
	if err := p.Emit(map[string]any{"count": 2}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "{\"count\":2}\n" {
		t.Fatalf("stdout: %q", out.String())
	}
	if errb.Len() != 0 {
		t.Fatalf("stderr should stay empty: %q", errb.String())
	}
}

func TestWarningsAndHintsGoToStderr(t *testing.T) {
	p, out, errb := newPrinter()
	p.Warnf("config file is group-readable")
	p.Hintf("No matching tasks.")
	p.Debugf("not printed without --debug")
	if out.Len() != 0 {
		t.Fatalf("nothing may reach stdout: %q", out.String())
	}
	if !strings.Contains(errb.String(), "config file is group-readable") || !strings.Contains(errb.String(), "No matching tasks.") {
		t.Fatalf("stderr: %q", errb.String())
	}
	if strings.Contains(errb.String(), "not printed") {
		t.Fatalf("--debug output leaked: %q", errb.String())
	}

	p.Debug = true
	p.Debugf("now printed")
	if !strings.Contains(errb.String(), "now printed") {
		t.Fatalf("stderr: %q", errb.String())
	}
}

func TestFailEnvelopeGoesToStdoutOnlyUnderJSON(t *testing.T) {
	p, out, errb := newPrinter()
	p.Fail("not_found", errors.New("task not found"))
	if out.Len() != 0 {
		t.Fatalf("without --json nothing may reach stdout: %q", out.String())
	}
	if !strings.HasPrefix(errb.String(), "tdo: task not found") {
		t.Fatalf("stderr: %q", errb.String())
	}

	p, out, errb = newPrinter()
	p.JSON = true
	p.Fail("not_found", errors.New("task not found"))
	if errb.Len() != 0 {
		t.Fatalf("under --json the message belongs on stdout: %q", errb.String())
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(out.Bytes(), &envelope); err != nil {
		t.Fatalf("stdout is not the error envelope: %q", out.String())
	}
	if envelope.Error.Code != "not_found" || envelope.Error.Message != "task not found" {
		t.Fatalf("envelope: %+v", envelope)
	}
}

func sampleTask() *task.Task {
	now := time.Date(2026, 10, 20, 4, 11, 0, 0, time.UTC)
	due := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	t := &task.Task{
		ID:        "01J3ZQK8V9XW5S6R7T8Y9Z0A1B",
		Kind:      task.KindTask,
		Title:     "Pay the invoice",
		Status:    task.StatusActive,
		DueAt:     &due,
		CreatedAt: now,
		UpdatedAt: now,
		Fields:    task.Fields{task.KeyPriority: 2, "client": "acme"},
	}
	t.SetTags([]string{"finance", "ops"})
	return t
}

func TestTableStaysWithinEightyColumns(t *testing.T) {
	long := sampleTask()
	long.Title = strings.Repeat("a very long title ", 10)
	long.SetTags([]string{"one", "two", "three", "four", "five", "six"})

	var buf bytes.Buffer
	if err := Table(&buf, Rows([]*task.Task{sampleTask(), long})); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected a header and two rows: %q", buf.String())
	}
	if !strings.Contains(lines[0], "TITLE") {
		t.Fatalf("header: %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "1 ") {
		t.Fatalf("the first column is the short number: %q", lines[1])
	}
	for _, line := range lines {
		if n := len([]rune(line)); n > 80 {
			t.Fatalf("line is %d columns wide: %q", n, line)
		}
	}
	if !strings.Contains(lines[1], "2026-11-01") || !strings.Contains(lines[1], "finance") {
		t.Fatalf("row is missing the due date or the tags: %q", lines[1])
	}
}

func TestTableMarksDoneAndDeleted(t *testing.T) {
	done := sampleTask()
	done.Status = task.StatusDone
	deleted := sampleTask()
	at := time.Now().UTC()
	deleted.DeletedAt = &at

	var buf bytes.Buffer
	if err := Table(&buf, Rows([]*task.Task{done, deleted})); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if !strings.HasPrefix(lines[1], "1  x") {
		t.Fatalf("a completed task is marked x: %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "2  -") {
		t.Fatalf("a tombstone is marked -: %q", lines[2])
	}
}

func TestDetailListsEveryField(t *testing.T) {
	var buf bytes.Buffer
	if err := Detail(&buf, Row{Task: sampleTask()}, nil); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"01J3ZQK8V9XW5S6R7T8Y9Z0A1B", "Pay the invoice", "active", "client", "acme", "finance,ops"} {
		if !strings.Contains(buf.String(), want) {
			t.Fatalf("detail is missing %q: %q", want, buf.String())
		}
	}
}

func TestFieldTextRendersStructuredValues(t *testing.T) {
	cases := map[string]any{
		"acme":          "acme",
		"1,2":           []any{1, 2},
		"a,b":           []string{"a", "b"},
		"{k=1 owner=a}": map[string]any{"owner": "a", "k": 1},
		"3":             3,
	}
	for want, value := range cases {
		if got := fieldText(value); got != want {
			t.Fatalf("fieldText(%v) = %q, want %q", value, got, want)
		}
	}
}
