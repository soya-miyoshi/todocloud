package cli

import (
	"context"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

func (a *app) doneCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "done",
		Usage:     "complete items, creating the successor of a repeating one",
		ArgsUsage: "<ref...>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "no-repeat",
				Usage: "complete without creating the next instance",
			},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			tasks, err := a.resolveRefs(ctx, st, cmd.Args().Slice())
			if err != nil {
				return err
			}
			noRepeat := cmd.Bool("no-repeat")

			now := time.Now().UTC()
			completed := make([]*task.Task, 0, len(tasks))
			successors := make([]*task.Task, 0, len(tasks))
			var auto autoCompletions
			for _, found := range tasks {
				t := found.Clone()
				var next *task.Task
				if noRepeat {
					// The one way to end a repeating item without a
					// successor, short of `tdo repeat --stop`.
					t.SetStatus(task.StatusDone, now)
				} else {
					// This is the only call in the CLI that creates a row
					// nobody typed, and it is reached only from here (§3.4).
					next, err = recur.Complete(t, now, id.New())
					if err != nil {
						return err
					}
				}
				// The successor goes in BEFORE the instance is completed,
				// and the order is load-bearing. Completing the instance may
				// be the last action of a complete-with-last container
				// (PLAN.md §3.3a), and the store closes that container as
				// part of the same Update. Adding the successor afterwards
				// would file it under a container that is already done;
				// adding it first makes it the live sibling that correctly
				// prevents the auto-completion. It also fails more safely:
				// if Add fails, the instance is still open.
				if next != nil {
					if err := treeError(st.Add(ctx, next)); err != nil {
						return err
					}
					successors = append(successors, next)
				}
				if err := auto.collect(ctx, st, t, now); err != nil {
					return err
				}
				if err := st.Update(ctx, t); err != nil {
					return err
				}
				completed = append(completed, t)
			}

			if !a.out.JSON && len(successors) > 0 {
				// "says so" of §4.1: a successor appearing is the point of a
				// repeat, so it is never silent.
				for _, next := range successors {
					a.out.Hintf("repeats: %s is next", id.Short(next.ID, 8))
				}
			}
			av, err := a.availabilityOf(ctx, st, successors)
			if err != nil {
				return err
			}
			return a.renderTasks(ctx, st, completed,
				a.report(&auto, map[string]any{"repeated": views(successors, av)}))
		}),
	}
}

// statusCommand builds the commands that only move an item between the four
// statuses. They are one function because the difference between them is one
// value, and a hold that behaved unlike a drop would be a bug.
func (a *app) statusCommand(name, usage string, status task.Status) *ucli.Command {
	return &ucli.Command{
		Name:      name,
		Usage:     usage,
		ArgsUsage: "<ref...>",
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			tasks, err := a.resolveRefs(ctx, st, cmd.Args().Slice())
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			updated := make([]*task.Task, 0, len(tasks))
			var auto autoCompletions
			for _, found := range tasks {
				t := found.Clone()
				t.SetStatus(status, now)
				if err := auto.collect(ctx, st, t, now); err != nil {
					return err
				}
				if err := st.Update(ctx, t); err != nil {
					return err
				}
				updated = append(updated, t)
			}
			return a.renderTasks(ctx, st, updated, a.report(&auto, nil))
		}),
	}
}

// flagCommand builds `tdo flag` and `tdo unflag`.
func (a *app) flagCommand(name, usage string, flagged bool) *ucli.Command {
	return &ucli.Command{
		Name:      name,
		Usage:     usage,
		ArgsUsage: "<ref...>",
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			tasks, err := a.resolveRefs(ctx, st, cmd.Args().Slice())
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			updated := make([]*task.Task, 0, len(tasks))
			for _, found := range tasks {
				t := found.Clone()
				t.Flagged = flagged
				t.UpdatedAt = now
				if err := st.Update(ctx, t); err != nil {
					return err
				}
				updated = append(updated, t)
			}
			return a.renderTasks(ctx, st, updated, nil)
		}),
	}
}

// dateCommand builds `tdo defer` and `tdo due`, which differ only in which
// date they write. The date is the last argument, so that several items can
// be given one date in one command; --clear takes its place.
func (a *app) dateCommand(name, usage string, set func(t *task.Task, at *time.Time)) *ucli.Command {
	return &ucli.Command{
		Name:      name,
		Usage:     usage,
		ArgsUsage: "<ref...> <when|--clear>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{Name: "clear", Usage: "remove the date instead of setting one"},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			clear := cmd.Bool("clear")

			var at *time.Time
			if !clear {
				if len(args) < 2 {
					return usagef("%s expects one or more references and a date, or --clear", name)
				}
				parsed, err := parseInstant(args[len(args)-1])
				if err != nil {
					return err
				}
				at = parsed
				args = args[:len(args)-1]
			}

			tasks, err := a.resolveRefs(ctx, st, args)
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			updated := make([]*task.Task, 0, len(tasks))
			for _, found := range tasks {
				t := found.Clone()
				set(t, at)
				t.UpdatedAt = now
				if err := st.Update(ctx, t); err != nil {
					return err
				}
				updated = append(updated, t)
			}
			return a.renderTasks(ctx, st, updated, nil)
		}),
	}
}

func (a *app) moveCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "mv",
		Usage:     "reparent items; a move that would make a cycle is refused",
		ArgsUsage: "<ref...> <parent-ref|--inbox|--top>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{Name: "inbox", Usage: "move tasks to the inbox, which is the absence of a parent"},
			&ucli.BoolFlag{Name: "top", Usage: "move folders and projects to the top level"},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			// --inbox and --top are the same destination — no parent — under
			// the two names the tree gives it, so one item can be moved out
			// of its container whatever kind it is.
			toTop := cmd.Bool("inbox") || cmd.Bool("top")

			var parentID string
			if !toTop {
				if len(args) < 2 {
					return usagef("mv expects one or more references and a destination, or --inbox / --top")
				}
				// The destination is a container by definition, so it is
				// resolved the way every other container reference is: a
				// number, an id prefix, or a title. Accepting a title for
				// `tdo add --project` but not for the command that files an
				// item afterwards is an asymmetry with nothing behind it.
				// The title is still tried last, so a number never changes
				// meaning, and two containers sharing one exit 6.
				parent, err := a.resolveContainer(ctx, st, args[len(args)-1],
					task.KindFolder, task.KindProject, task.KindTask)
				if err != nil {
					return err
				}
				parentID = parent.ID
				args = args[:len(args)-1]
			}

			tasks, err := a.resolveRefs(ctx, st, args)
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			moved := make([]*task.Task, 0, len(tasks))
			for _, t := range tasks {
				if err := treeError(st.Move(ctx, t.ID, parentID, t.Position, now)); err != nil {
					return err
				}
				after, err := st.Get(ctx, t.ID)
				if err != nil {
					return err
				}
				moved = append(moved, after)
			}
			return a.renderTasks(ctx, st, moved, nil)
		}),
	}
}

// statusCommands returns the five commands that only change a status, plus
// the two that only change the flag.
func (a *app) markCommands() []*ucli.Command {
	return []*ucli.Command{
		a.doneCommand(),
		a.statusCommand("undone", "put completed items back to active", task.StatusActive),
		a.statusCommand("drop", "decide against items without deleting them", task.StatusDropped),
		a.statusCommand("hold", "put items on hold, with everything inside them", task.StatusOnHold),
		a.statusCommand("unhold", "take items off hold", task.StatusActive),
		a.flagCommand("flag", "flag items", true),
		a.flagCommand("unflag", "remove the flag from items", false),
		a.dateCommand("defer", "set or clear the date before which items are not available",
			func(t *task.Task, at *time.Time) { t.DeferAt = at }),
		a.dateCommand("due", "set or clear the date items are due",
			func(t *task.Task, at *time.Time) { t.DueAt = at }),
		a.moveCommand(),
	}
}
