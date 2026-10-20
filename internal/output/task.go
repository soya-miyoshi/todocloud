package output

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
	"unicode/utf8"

	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// titleWidth is the longest title the table prints before truncating it. The
// other columns add up to about 32 characters, which keeps the whole row
// inside an 80-column terminal. A tree row spends part of it on indentation,
// so the column width is the same either way and the indent eats into the
// title rather than into the terminal.
const titleWidth = 34

// tagsWidth is the same idea for the tag column.
const tagsWidth = 16

// indentWidth is how far one level of the tree shifts a title. Two spaces is
// enough to read the nesting and cheap enough that a deep branch still leaves
// room for a title.
const indentWidth = 2

// Row is one line of a listing: the task, how deep it sits in the tree when
// the listing is printed as one, and what §3.3 says about it. Availability
// travels with the row because the reason an item is blocked lives above it
// in the tree, where the renderer cannot see.
type Row struct {
	Task  *task.Task
	Depth int
	// Availability is the answer for this task. The zero value — not
	// available, no rule — is what a caller passes when it did not ask, and
	// renders as an ordinary row.
	Availability store.Availability
	// Asked records that Availability was computed. Without it a zero value
	// would be indistinguishable from "blocked for no stated reason".
	Asked bool
}

// Rows pairs tasks with no availability, for the listings where it is not the
// question being asked.
func Rows(tasks []*task.Task) []Row {
	out := make([]Row, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, Row{Task: t})
	}
	return out
}

// Table writes rows as a numbered table. The number in the first column is
// the short reference the next command accepts, so it must match the order the
// ids were cached in.
//
// Rows are written through a tabwriter and then stripped of trailing spaces:
// an empty last column would otherwise pad every row to the same width, which
// shows up as noise when the output is diffed or pasted.
func Table(w io.Writer, rows []Row) error {
	var buf strings.Builder
	tw := tabwriter.NewWriter(&buf, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "#\tS\tK\tDUE\tTITLE\tTAGS")
	for i, r := range rows {
		fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\n",
			i+1,
			stateMarker(r),
			kindMarker(r.Task),
			dueCell(r.Task),
			indented(r),
			truncate(sanitize(strings.Join(r.Task.Tags, ",")), tagsWidth),
		)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	for _, line := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		if _, err := io.WriteString(w, strings.TrimRight(line, " \t")+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// indented renders the title at its depth in the tree, truncating what is
// left of the column rather than the column itself, so the table keeps its
// width however deep the branch goes.
func indented(r Row) string {
	title := sanitize(r.Task.Title)
	if r.Depth <= 0 {
		return truncate(title, titleWidth)
	}
	pad := r.Depth * indentWidth
	if pad > titleWidth-4 {
		// Past this the title would be all indentation; stop moving right.
		pad = titleWidth - 4
	}
	return strings.Repeat(" ", pad) + truncate(title, titleWidth-pad)
}

// stateMarker is two characters: where the item stands, and whether it is
// flagged. A blocked-but-active item is marked so that `--all` and
// `--blocked` listings do not look like `tdo ls`.
func stateMarker(r Row) string {
	t := r.Task
	state := " "
	switch {
	case t.Deleted():
		state = "-"
	case t.Status == task.StatusDone:
		state = "x"
	case t.Status == task.StatusDropped:
		state = "~"
	case t.Status == task.StatusOnHold:
		state = "h"
	case r.Asked && !r.Availability.Available && t.Actionable():
		state = "!"
	}
	if t.Flagged {
		return state + "*"
	}
	return state
}

// kindMarker is one character per kind, so a tree of folders, projects and
// actions reads without a legend: f, p, and a blank for an ordinary action.
func kindMarker(t *task.Task) string {
	switch t.Kind {
	case task.KindFolder:
		return "f"
	case task.KindProject:
		return "p"
	default:
		return ""
	}
}

func dueCell(t *task.Task) string {
	if t.DueAt == nil {
		return ""
	}
	return t.DueAt.UTC().Format(task.DueDateFormat)
}

// sanitize makes a stored string safe to write to a terminal.
//
// A title is user data, and user data reaches this renderer unchanged: a value
// holding an ANSI escape would colour the rest of the display, a carriage
// return would overwrite the row above it, and a NUL or a backspace would make
// the output lie about what is stored. Control characters are therefore
// rendered the way Go would quote them, which keeps the row readable and keeps
// `tdo show` an honest view of the data. Machine output is untouched: JSON
// escapes these characters itself.
func sanitize(s string) string {
	if !strings.ContainsFunc(s, isControl) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case !isControl(r):
			b.WriteRune(r)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == 0x1b:
			b.WriteString(`\e`)
		default:
			// Every remaining control rune is below 0x100 — C0, DEL and C1 —
			// so a two-digit escape covers them all.
			fmt.Fprintf(&b, `\x%02x`, r)
		}
	}
	return b.String()
}

// isControl reports whether r is a C0 or C1 control character, or DEL.
func isControl(r rune) bool {
	return r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f)
}

// truncate shortens s to at most n characters, marking the cut with an
// ellipsis so a clipped title is never mistaken for the whole one.
func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n-1]) + "…"
}

// Detail writes one task as a block of labelled lines, for `tdo show` and for
// the human-readable form of the commands that change one task.
//
// blockedBy, when given, is the task named in the availability answer. It is
// passed in rather than looked up because the renderer has no store: the whole
// point of `tdo show` on a blocked item is to name the project or the sibling
// that is holding it, and that may be nowhere near the item.
func Detail(w io.Writer, r Row, blockedBy *task.Task) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	t := r.Task

	fmt.Fprintf(tw, "id\t%s\n", sanitize(t.ID))
	fmt.Fprintf(tw, "kind\t%s\n", t.Kind)
	fmt.Fprintf(tw, "title\t%s\n", sanitize(t.Title))

	status := string(t.Status)
	if t.Deleted() {
		status += " (deleted)"
	}
	fmt.Fprintf(tw, "status\t%s\n", status)

	if r.Asked {
		if r.Availability.Available {
			fmt.Fprintf(tw, "available\tyes\n")
		} else {
			fmt.Fprintf(tw, "available\tno (%s)\n", BlockedReason(r.Availability, blockedBy))
		}
	}
	if t.ParentID != "" {
		fmt.Fprintf(tw, "parent\t%s\n", sanitize(t.ParentID))
	} else if t.Inbox() {
		fmt.Fprintf(tw, "parent\tinbox\n")
	}
	if t.Position != 0 {
		fmt.Fprintf(tw, "position\t%d\n", t.Position)
	}
	if t.Flagged {
		fmt.Fprintf(tw, "flagged\tyes\n")
	}
	if t.Sequential {
		fmt.Fprintf(tw, "sequential\tyes\n")
	}
	if t.CompletedByChildren {
		fmt.Fprintf(tw, "completes with last child\tyes\n")
	}
	if t.DeferAt != nil {
		fmt.Fprintf(tw, "defer\t%s\n", task.FormatTime(*t.DeferAt))
	}
	if t.DueAt != nil {
		fmt.Fprintf(tw, "due\t%s\n", task.FormatTime(*t.DueAt))
	}
	if t.EstimatedMinutes > 0 {
		fmt.Fprintf(tw, "estimate\t%dm\n", t.EstimatedMinutes)
	}
	if len(t.Tags) > 0 {
		fmt.Fprintf(tw, "tags\t%s\n", sanitize(strings.Join(t.Tags, ",")))
	}
	if t.Repeat != nil {
		fmt.Fprintf(tw, "repeat\t%s (%s)\n", sanitize(t.Repeat.Every), t.Repeat.Method)
	}
	if t.SeriesID != "" {
		fmt.Fprintf(tw, "series\t%s\n", sanitize(t.SeriesID))
	}
	if t.ReviewInterval != nil {
		fmt.Fprintf(tw, "review every\t%s\n", sanitize(t.ReviewInterval.Every))
		if next, ok := recur.NextReviewAt(t, nowOf(t)); ok {
			fmt.Fprintf(tw, "next review\t%s\n", task.FormatTime(next))
		}
	}
	if t.LastReviewedAt != nil {
		fmt.Fprintf(tw, "last reviewed\t%s\n", task.FormatTime(*t.LastReviewedAt))
	}
	if t.Note != "" {
		fmt.Fprintf(tw, "note\t%s\n", sanitize(t.Note))
	}
	fmt.Fprintf(tw, "created\t%s\n", task.FormatTime(t.CreatedAt))
	fmt.Fprintf(tw, "updated\t%s\n", task.FormatTime(t.UpdatedAt))
	if t.CompletedAt != nil {
		fmt.Fprintf(tw, "completed\t%s\n", task.FormatTime(*t.CompletedAt))
	}
	if t.DroppedAt != nil {
		fmt.Fprintf(tw, "dropped\t%s\n", task.FormatTime(*t.DroppedAt))
	}
	if t.DeletedAt != nil {
		fmt.Fprintf(tw, "deleted\t%s\n", task.FormatTime(*t.DeletedAt))
	}
	for _, key := range t.Fields.Keys() {
		fmt.Fprintf(tw, "%s\t%s\n", sanitize(key), sanitize(fieldText(t.Fields[key])))
	}
	return tw.Flush()
}

// nowOf is the instant a derived review date is rendered against. A task that
// has never been reviewed is due now, and "now" for a rendering is the
// task's own updated_at: using the wall clock here would make the same task
// print differently on two consecutive runs.
func nowOf(t *task.Task) time.Time { return t.UpdatedAt }

// BlockedReason puts an availability answer into one clause a person can act
// on. The blocking item is named by title when the caller could fetch it,
// because an id is not an answer to "why can I not do this".
func BlockedReason(a store.Availability, by *task.Task) string {
	name := a.BlockedBy
	if by != nil {
		name = fmt.Sprintf("%q", sanitize(by.Title))
	} else if name == "" {
		name = "an item that is not in this store"
	}
	switch a.Rule {
	case store.RuleNone:
		return "nothing is blocking it"
	case store.RuleNotActionable:
		return "a folder organises; it is not something to do"
	case store.RuleDeleted:
		return "it has been removed"
	case store.RuleStatus:
		return "its own status is not active"
	case store.RuleDeferred:
		return "it is deferred until later"
	case store.RuleSequential:
		return fmt.Sprintf("%s comes first in this sequential list", name)
	case store.RuleMissingParent:
		return fmt.Sprintf("its parent %s is not in this store", a.BlockedBy)
	case store.RuleAncestorDeleted:
		return fmt.Sprintf("%s, which contains it, has been removed", name)
	case store.RuleAncestorStatus:
		return fmt.Sprintf("%s, which contains it, is not active", name)
	case store.RuleAncestorDeferred:
		return fmt.Sprintf("%s, which contains it, is deferred until later", name)
	case store.RuleAncestorSequential:
		return fmt.Sprintf("%s has not come up yet in its sequential list", name)
	default:
		return string(a.Rule)
	}
}

// fieldText renders a user-defined value for a human. A list becomes a
// comma-separated line; anything structured falls back to Go's own rendering,
// which is enough for a value the user put there themselves.
func fieldText(v any) string {
	switch val := v.(type) {
	case string:
		return val
	case []string:
		return strings.Join(val, ",")
	case []any:
		parts := make([]string, 0, len(val))
		for _, e := range val {
			parts = append(parts, fmt.Sprint(e))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, k+"="+fmt.Sprint(val[k]))
		}
		return "{" + strings.Join(parts, " ") + "}"
	default:
		return fmt.Sprint(val)
	}
}
