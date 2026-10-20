package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/output"
	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// taskView is the JSON shape of one task everywhere in the CLI: the stored
// task, flattened as task.Task marshals it, plus the three derived keys a
// caller must not have to recompute — `available`, `blocked_by` and
// `next_review_at` (§3.3, §3.5).
//
// Every command that emits a task emits this, so an agent parses one shape
// rather than one per command. `blocked_by` is null when the item is
// available, and an object naming the rule and the item responsible when it
// is not.
type taskView struct {
	task         *task.Task
	availability store.Availability
	// asked records that availability was computed for this task. A command
	// that cannot know it — there is none today — would emit null rather
	// than claim the item is blocked for no reason.
	asked bool
}

// blockedBy is the documented object under the `blocked_by` key.
type blockedBy struct {
	Rule   string `json:"rule"`
	TaskID string `json:"task_id"`
}

func (v taskView) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(v.task)
	if err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}

	add := func(key string, value any) error {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		out[key] = encoded
		return nil
	}

	if v.asked {
		if err := add(task.KeyAvailable, v.availability.Available); err != nil {
			return nil, err
		}
		var blocker any
		if !v.availability.Available {
			blocker = blockedBy{Rule: string(v.availability.Rule), TaskID: v.availability.BlockedBy}
		}
		if err := add(task.KeyBlockedBy, blocker); err != nil {
			return nil, err
		}
	} else {
		if err := add(task.KeyAvailable, nil); err != nil {
			return nil, err
		}
		if err := add(task.KeyBlockedBy, nil); err != nil {
			return nil, err
		}
	}

	// next_review_at is derived from last_reviewed_at and the interval, so it
	// cannot drift out of sync with either half (§3.5). It is null on
	// anything with no review interval, which is every task.
	var nextReview any
	if next, ok := recur.NextReviewAt(v.task, v.task.UpdatedAt); ok {
		nextReview = task.FormatTime(next)
	}
	if err := add(task.KeyNextReview, nextReview); err != nil {
		return nil, err
	}
	return json.Marshal(out)
}

// views pairs tasks with the availability answer for each of them.
func views(tasks []*task.Task, av map[string]store.Availability) []taskView {
	out := make([]taskView, 0, len(tasks))
	for _, t := range tasks {
		a, ok := av[t.ID]
		out = append(out, taskView{task: t, availability: a, asked: ok})
	}
	return out
}

// availabilityOf asks the store for §3.3 over these tasks. It is a read, and
// the one place the command layer learns why something is blocked: the rules
// are computed in the store so that every provider and every command agree.
func (a *app) availabilityOf(ctx context.Context, st store.Store, tasks []*task.Task) (map[string]store.Availability, error) {
	if len(tasks) == 0 {
		return map[string]store.Availability{}, nil
	}
	ids := make([]string, 0, len(tasks))
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	return st.Availability(ctx, time.Now().UTC(), ids...)
}

// renderTask writes the single-task shape, {"task":{…}}, or a human detail
// block that says why the task is blocked when it is.
func (a *app) renderTask(ctx context.Context, st store.Store, t *task.Task) error {
	av, err := a.availabilityOf(ctx, st, []*task.Task{t})
	if err != nil {
		return err
	}
	answer, asked := av[t.ID]
	if a.out.JSON {
		return a.out.Emit(map[string]any{"task": taskView{task: t, availability: answer, asked: asked}})
	}
	// The item holding this one back is usually somewhere else in the tree,
	// so it is fetched by id rather than inferred from what is on screen.
	var by *task.Task
	if asked && !answer.Available && answer.BlockedBy != "" && answer.BlockedBy != t.ID {
		if found, err := st.Get(ctx, answer.BlockedBy); err == nil {
			by = found
		}
	}
	return output.Detail(a.out.Out, output.Row{Task: t, Availability: answer, Asked: asked}, by)
}

// renderTasks writes the bulk shape, {"tasks":[…],"count":n}, or a table.
// extra adds keys to the JSON object — `tdo done` reports its successors
// there — and is ignored for human output.
func (a *app) renderTasks(ctx context.Context, st store.Store, tasks []*task.Task, extra map[string]any) error {
	av, err := a.availabilityOf(ctx, st, tasks)
	if err != nil {
		return err
	}
	if a.out.JSON {
		payload := map[string]any{"tasks": views(tasks, av), "count": len(tasks)}
		for k, v := range extra {
			payload[k] = v
		}
		return a.out.Emit(payload)
	}
	return a.printTable(tasks, av, false)
}

// printTable writes the human listing. tree asks for the nesting to be shown
// by indentation; depth is measured against the tasks actually listed, so a
// row is never indented under something the filter hid.
func (a *app) printTable(tasks []*task.Task, av map[string]store.Availability, tree bool) error {
	rows := make([]output.Row, 0, len(tasks))
	depth := make(map[string]int, len(tasks))
	listed := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		listed[t.ID] = true
	}
	for _, t := range tasks {
		d := 0
		if tree && t.ParentID != "" && listed[t.ParentID] {
			d = depth[t.ParentID] + 1
		}
		depth[t.ID] = d
		answer, asked := av[t.ID]
		rows = append(rows, output.Row{Task: t, Depth: d, Availability: answer, Asked: asked})
	}
	return output.Table(a.out.Out, rows)
}

// treeError turns the two tree rules of §3.1 into usage errors. An illegal
// parent/kind pairing and a move that would make a cycle are mistakes at the
// command line, not store failures, and §4.2 fixes them at exit 2.
func treeError(err error) error {
	if err != nil && (errors.Is(err, store.ErrBadParent) || errors.Is(err, store.ErrCycle)) {
		return exit.Usagef(err)
	}
	return err
}

// countLine renders a count with the right noun, for the one-line summaries
// the human output ends with.
func countLine(n int, singular, plural string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, singular)
	}
	return fmt.Sprintf("%d %s", n, plural)
}

// autoCompletions collects the containers that writing t will complete under
// PLAN.md §3.3a. It is called immediately before the write, because the rule
// reads the tree as it will be afterwards, and it uses the same shared
// function the providers do, so what is reported and what is written cannot
// drift apart.
//
// A container appears once however many of its children closed in the same
// command: `tdo done a b` where a and b are the last two actions of one
// project completes that project once.
type autoCompletions struct {
	seen  map[string]bool
	tasks []*task.Task
}

func (c *autoCompletions) collect(ctx context.Context, st store.Store, t *task.Task, now time.Time) error {
	containers, err := store.PendingAutoCompletions(ctx, st, t, now)
	if err != nil {
		return err
	}
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	for _, container := range containers {
		if c.seen[container.ID] {
			continue
		}
		c.seen[container.ID] = true
		c.tasks = append(c.tasks, container)
	}
	return nil
}

// report adds the containers to a command's output: a line on stderr for a
// human, and a "completed_with_last" array for a machine. A project leaving
// `tdo ls` because its last action closed is not something to discover later.
func (a *app) report(c *autoCompletions, extra map[string]any) map[string]any {
	if len(c.tasks) == 0 {
		return extra
	}
	if !a.out.JSON {
		for _, container := range c.tasks {
			a.out.Hintf("completed with its last action: %s %s",
				id.Short(container.ID, 8), container.Title)
		}
		return extra
	}
	if extra == nil {
		extra = map[string]any{}
	}
	extra["completed_with_last"] = views(c.tasks, nil)
	return extra
}
