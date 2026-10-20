package cli

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/output"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

// views pairs tasks with the availability answer for each of them. The shape
// it renders lives in output, because `tdo serve` emits the same one.
func views(tasks []*task.Task, av map[string]store.Availability) []output.TaskView {
	return output.Views(tasks, av)
}

// availabilityOf asks the shared layer for §3.3 over these tasks: the rules
// are computed in the store so that every provider and every command agree.
func (a *app) availabilityOf(ctx context.Context, st store.Store, tasks []*task.Task) (map[string]store.Availability, error) {
	return taskops.AvailabilityOf(ctx, st, tasks, time.Now().UTC())
}

// renderTask writes one task: the same JSON shape every other command uses,
// {"tasks":[…],"count":n}, or a human detail block that says why the task is
// blocked when it is.
//
// There used to be a second shape, {"task":{…}}, for the commands that act on
// exactly one item. One shape costs a caller `.tasks[0]` where it knows there
// is one item, and saves it from having to know which commands are which:
// `jq '.task // .tasks[]'` was the only way to write a line that worked for
// both. Nothing has been released, so the two were merged rather than kept
// (PLAN.md §9).
func (a *app) renderTask(ctx context.Context, st store.Store, t *task.Task) error {
	av, err := a.availabilityOf(ctx, st, []*task.Task{t})
	if err != nil {
		return err
	}
	answer, asked := av[t.ID]
	if a.out.JSON {
		return a.out.Emit(map[string]any{
			"tasks": []output.TaskView{output.NewTaskView(t, answer, asked)},
			"count": 1,
		})
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

// report adds the containers a write closed under §3.3a to a command's
// output: a line on stderr for a
// human, and a "completed_with_last" array for a machine. A project leaving
// `tdo ls` because its last action closed is not something to discover later.
func (a *app) report(completed []*task.Task, extra map[string]any) map[string]any {
	if len(completed) == 0 {
		return extra
	}
	if !a.out.JSON {
		for _, container := range completed {
			a.out.Hintf("completed with its last action: %s %s",
				id.Short(container.ID, 8), container.Title)
		}
		return extra
	}
	if extra == nil {
		extra = map[string]any{}
	}
	extra["completed_with_last"] = views(completed, nil)
	return extra
}
