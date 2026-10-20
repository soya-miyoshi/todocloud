package output

import (
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// An empty trailing column must not pad the row: the padding would show up as
// noise whenever the table is diffed, pasted or snapshotted.
func TestTableHasNoTrailingWhitespace(t *testing.T) {
	at := time.Date(2026, 10, 20, 4, 11, 0, 0, time.UTC)
	due := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	tasks := []*task.Task{
		{
			ID: "01J3ZQK8V9XW5S6R7T8Y9Z0A1B", Kind: task.KindTask, Title: "Pay the invoice",
			Status: task.StatusActive, DueAt: &due, Tags: []string{"finance"},
			CreatedAt: at, UpdatedAt: at, Fields: task.Fields{task.KeyPriority: 2},
		},
		// No due date, no tags, no flag: every optional column is empty.
		{ID: "01J3ZQK8V9XW5S6R7T8Y9Z0A1C", Kind: task.KindTask, Title: "Buy milk",
			Status: task.StatusActive, CreatedAt: at, UpdatedAt: at, Fields: task.Fields{}},
	}

	var buf strings.Builder
	if err := Table(&buf, Rows(tasks)); err != nil {
		t.Fatalf("Table: %v", err)
	}

	out := buf.String()
	if !strings.HasSuffix(out, "\n") {
		t.Error("the table does not end with a newline")
	}
	for i, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if line != strings.TrimRight(line, " \t") {
			t.Errorf("line %d has trailing whitespace: %q", i+1, line)
		}
	}
	if lines := strings.Count(out, "\n"); lines != len(tasks)+1 {
		t.Errorf("table has %d lines, want %d (one header plus one row per task)", lines, len(tasks)+1)
	}
}

func TestTableWithNoTasksPrintsOnlyTheHeader(t *testing.T) {
	var buf strings.Builder
	if err := Table(&buf, nil); err != nil {
		t.Fatalf("Table: %v", err)
	}
	if got := strings.Count(buf.String(), "\n"); got != 1 {
		t.Errorf("empty table has %d lines, want 1", got)
	}
}
