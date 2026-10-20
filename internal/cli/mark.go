package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
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

			res, err := taskops.Complete(ctx, st, tasks, time.Now().UTC(), noRepeat, id.New)
			if err != nil {
				return treeError(err)
			}
			successors := res.Successors

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
			return a.renderTasks(ctx, st, res.Tasks,
				a.report(res.AutoCompleted, map[string]any{"repeated": views(successors, av)}))
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
			res, err := taskops.SetStatus(ctx, st, tasks, status, time.Now().UTC())
			if err != nil {
				return err
			}
			return a.renderTasks(ctx, st, res.Tasks, a.report(res.AutoCompleted, nil))
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
			res, err := taskops.SetFlagged(ctx, st, tasks, flagged, time.Now().UTC())
			if err != nil {
				return err
			}
			return a.renderTasks(ctx, st, res.Tasks, nil)
		}),
	}
}

// dateCommand builds `tdo defer` and `tdo due`, which differ only in which
// date they write. The date is the last argument, so that several items can
// be given one date in one command; --clear takes its place.
func (a *app) dateCommand(name, usage string, field taskops.DateField) *ucli.Command {
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
			res, err := taskops.SetDate(ctx, st, tasks, field, at, time.Now().UTC())
			if err != nil {
				return err
			}
			return a.renderTasks(ctx, st, res.Tasks, nil)
		}),
	}
}

func (a *app) moveCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "mv",
		Usage:     "reparent or reorder items; a move that would make a cycle is refused",
		ArgsUsage: "<ref...> <parent-ref|--inbox|--top|--before R|--after R>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{Name: "inbox", Usage: "move tasks to the inbox, which is the absence of a parent"},
			&ucli.BoolFlag{Name: "top", Usage: "move folders and projects to the top level"},
			&ucli.StringFlag{Name: "before", Usage: "put the items immediately before item `R`"},
			&ucli.StringFlag{Name: "after", Usage: "put the items immediately after item `R`"},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			// --inbox and --top are the same destination — no parent — under
			// the two names the tree gives it, so one item can be moved out
			// of its container whatever kind it is.
			toTop := cmd.Bool("inbox") || cmd.Bool("top")
			if cmd.IsSet("before") || cmd.IsSet("after") {
				return a.reorder(ctx, cmd, st, args, toTop)
			}

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
			res, err := taskops.MoveTo(ctx, st, tasks, parentID, time.Now().UTC())
			if err != nil {
				return treeError(err)
			}
			return a.renderTasks(ctx, st, res.Tasks, nil)
		}),
	}
}

// reorder is `tdo mv <ref...> --before R` / `--after R`: the one way to say
// where an item sits among its siblings.
//
// In a sequential project the order of the children is the order they become
// available (§3.3), so this is not cosmetic — without it, "do this one last"
// means deleting the action and adding it again, which loses its id, its
// note and its history.
func (a *app) reorder(ctx context.Context, cmd *ucli.Command, st store.Store, args []string, toTop bool) error {
	if cmd.IsSet("before") && cmd.IsSet("after") {
		return usagef("--before and --after ask for opposite things")
	}
	if toTop {
		return usagef("--before and --after place an item among its siblings; --inbox and --top take it out of its container")
	}
	where, ref := taskops.Before, strings.TrimSpace(cmd.String("before"))
	if cmd.IsSet("after") {
		where, ref = taskops.After, strings.TrimSpace(cmd.String("after"))
	}
	if ref == "" {
		return usagef("--before and --after need the item to place these ones next to")
	}
	if len(args) == 0 {
		return usagef("mv expects one or more references to move")
	}

	// The anchor is resolved first, so a reorder against a reference that
	// means nothing changes nothing.
	anchor, err := a.resolveRef(ctx, st, ref)
	if err != nil {
		return err
	}
	tasks, err := a.resolveRefs(ctx, st, args)
	if err != nil {
		return err
	}
	res, err := taskops.Reorder(ctx, st, tasks, anchor, where, time.Now().UTC())
	if err != nil {
		return treeError(err)
	}
	return a.renderTasks(ctx, st, res.Tasks, nil)
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
		a.dateCommand("defer", "set or clear the date before which items are not available", taskops.DeferDate),
		a.dateCommand("due", "set or clear the date items are due", taskops.DueDate),
		a.moveCommand(),
	}
}
