package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// The structure commands take a verb as their first argument rather than a
// urfave subcommand, because `tdo project <ref>` has to be told apart from
// `tdo project ls` at the same position. Dispatching here keeps that one
// decision in one place, and keeps every mistake at the command line an
// ordinary usage error.
func (a *app) projectCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "project",
		Usage:     "add, list or reshape a project",
		ArgsUsage: "add <title...> | ls | <ref>",
		Flags: append([]ucli.Flag{
			&ucli.StringFlag{Name: "folder", Usage: "put the project in folder `F`"},
			&ucli.BoolFlag{Name: "sequential", Usage: "its children must be done in order"},
			&ucli.BoolFlag{Name: "parallel", Usage: "its children may be done in any order"},
			&ucli.BoolFlag{Name: "complete-with-last", Usage: "complete the project when its last child is done"},
			&ucli.StringFlag{Name: "review", Usage: "review it every `EVERY`, for example 1w"},
			&ucli.BoolFlag{Name: "needs-review", Usage: "list only the projects due for review"},
			&ucli.StringSliceFlag{Name: "status", Usage: "keep one `STATUS`; may be repeated"},
			&ucli.StringFlag{Name: "note", Aliases: []string{"notes"}, Usage: "free-form note"},
			&ucli.StringSliceFlag{Name: "tag", Usage: "comma-separated `TAGS`; may be repeated"},
			&ucli.StringFlag{Name: "defer", Usage: "not available before `D`"},
			&ucli.StringFlag{Name: "due", Usage: "due date, `YYYY-MM-DD` or RFC 3339"},
			&ucli.BoolFlag{Name: "flag", Usage: "flag the project"},
			&ucli.StringFlag{Name: "estimate", Usage: "how long it will take, for example `25m`"},
		}, setFlags()...),
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) == 0 {
				return usagef("project expects `add <title...>`, `ls` or an item reference")
			}
			switch args[0] {
			case "add":
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.containerAdd(ctx, cmd, st, task.KindProject, args[1:])
				})
			case "ls", "list":
				if len(args) > 1 {
					return usagef("project ls takes no arguments")
				}
				return a.withStore(ctx, func(st store.Store) error {
					return a.projectList(ctx, cmd, st)
				})
			default:
				if len(args) > 1 {
					return usagef("project expects exactly one item reference")
				}
				return a.withStore(ctx, func(st store.Store) error {
					return a.projectReshape(ctx, cmd, st, args[0])
				})
			}
		}),
	}
}

func (a *app) folderCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "folder",
		Usage:     "add or list folders",
		ArgsUsage: "add <title...> | ls",
		Flags: append([]ucli.Flag{
			&ucli.StringFlag{Name: "folder", Usage: "put the folder inside folder `F`"},
			&ucli.StringFlag{Name: "review", Usage: "review it every `EVERY`, for example 1mo"},
			&ucli.StringFlag{Name: "note", Aliases: []string{"notes"}, Usage: "free-form note"},
			&ucli.BoolFlag{Name: "flag", Usage: "flag the folder"},
			&ucli.StringSliceFlag{Name: "tag", Usage: "comma-separated `TAGS`; may be repeated"},
			&ucli.StringSliceFlag{Name: "status", Usage: "keep one `STATUS`; may be repeated"},
		}, setFlags()...),
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) == 0 {
				return usagef("folder expects `add <title...>` or `ls`")
			}
			switch args[0] {
			case "add":
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.containerAdd(ctx, cmd, st, task.KindFolder, args[1:])
				})
			case "ls", "list":
				if len(args) > 1 {
					return usagef("folder ls takes no arguments")
				}
				return a.withStore(ctx, func(st store.Store) error {
					return a.containerList(ctx, cmd, st, task.KindFolder, false)
				})
			default:
				return usagef("folder expects `add <title...>` or `ls`")
			}
		}),
	}
}

// containerAdd creates a folder or a project. Both may only sit at the top
// level or inside a folder, so they share one parent flag and the store's
// containment check does the rest.
func (a *app) containerAdd(ctx context.Context, cmd *ucli.Command, st store.Store, kind task.Kind, args []string) error {
	title := strings.TrimSpace(strings.Join(args, " "))
	if title == "" {
		return usagef("expected a %s title", kind)
	}

	var parent *task.Task
	if ref := strings.TrimSpace(cmd.String("folder")); ref != "" {
		found, err := a.resolveContainer(ctx, st, ref, task.KindFolder)
		if err != nil {
			return err
		}
		parent = found
	}

	t, err := a.newItem(cmd, kind, title, parent)
	if err != nil {
		return err
	}
	if cmd.Bool("sequential") && cmd.Bool("parallel") {
		return usagef("--sequential and --parallel ask for opposite things")
	}
	t.Sequential = cmd.Bool("sequential")
	t.CompletedByChildren = cmd.Bool("complete-with-last")
	if cmd.IsSet("review") {
		interval, err := parseReviewInterval(cmd.String("review"))
		if err != nil {
			return err
		}
		t.ReviewInterval = interval
	}
	if err := t.Validate(); err != nil {
		return exit.Usagef(err)
	}
	if err := treeError(st.Add(ctx, t)); err != nil {
		return err
	}
	return a.renderTask(ctx, st, t)
}

// parseReviewInterval reads --review / --interval. The spelling is the one
// `recur` parses, and it is checked here so that an unreadable interval is a
// usage error rather than a project that silently never comes up for review.
func parseReviewInterval(raw string) (*task.ReviewInterval, error) {
	every := strings.TrimSpace(raw)
	if every == "" {
		return nil, usagef("a review interval must say how often, for example 1w")
	}
	if _, err := recur.ParseEvery(every); err != nil {
		return nil, exit.Usagef(err)
	}
	return &task.ReviewInterval{Every: every}, nil
}

func (a *app) projectList(ctx context.Context, cmd *ucli.Command, st store.Store) error {
	return a.containerList(ctx, cmd, st, task.KindProject, cmd.Bool("needs-review"))
}

// containerList lists folders or projects. Availability is not a filter here:
// the question "what projects are there" includes the ones on hold, which is
// exactly what a weekly review is for.
func (a *app) containerList(ctx context.Context, cmd *ucli.Command, st store.Store, kind task.Kind, needsReview bool) error {
	statuses, err := parseStatuses(cmd.StringSlice("status"))
	if err != nil {
		return err
	}
	if len(statuses) == 0 {
		statuses = openStatuses()
	}
	f := store.Filter{
		Kinds:    []task.Kind{kind},
		Statuses: statuses,
		Order:    store.OrderPosition,
	}
	if needsReview {
		// The same exclusive bound `tdo review` uses, for the same reason.
		cut := time.Now().UTC().Add(time.Millisecond)
		f.ReviewDueBefore = &cut
		f.Now = cut
	}
	tasks, err := st.List(ctx, f)
	if err != nil {
		return err
	}
	av, err := a.availabilityOf(ctx, st, tasks)
	if err != nil {
		return err
	}
	if a.out.JSON {
		return a.out.Emit(map[string]any{"tasks": views(tasks, av), "count": len(tasks)})
	}
	a.saveListing(st, tasks)
	if len(tasks) == 0 {
		a.out.Hintf("No %ss yet. `tdo %s add <title>` creates one.", kind, kind)
		return nil
	}
	return a.printTable(tasks, av, false)
}

// projectReshape is `tdo project <ref>`: with no flags it shows the project,
// and with them it changes the two things that decide how its children
// behave.
func (a *app) projectReshape(ctx context.Context, cmd *ucli.Command, st store.Store, ref string) error {
	found, err := a.resolveContainer(ctx, st, ref, task.KindProject, task.KindFolder)
	if err != nil {
		return err
	}
	changed := cmd.IsSet("sequential") || cmd.IsSet("parallel") || cmd.IsSet("complete-with-last") || cmd.IsSet("review")
	if !changed {
		return a.renderTask(ctx, st, found)
	}
	if cmd.Bool("sequential") && cmd.Bool("parallel") {
		return usagef("--sequential and --parallel ask for opposite things")
	}

	a.noticeOverriddenStore(st)
	t := found.Clone()
	switch {
	case cmd.IsSet("sequential"):
		t.Sequential = cmd.Bool("sequential")
	case cmd.IsSet("parallel"):
		t.Sequential = !cmd.Bool("parallel")
	}
	if cmd.IsSet("complete-with-last") {
		t.CompletedByChildren = cmd.Bool("complete-with-last")
	}
	if cmd.IsSet("review") {
		interval, err := parseReviewInterval(cmd.String("review"))
		if err != nil {
			return err
		}
		t.ReviewInterval = interval
	}
	t.UpdatedAt = time.Now().UTC()
	if err := t.Validate(); err != nil {
		return exit.Usagef(err)
	}
	if err := treeError(st.Update(ctx, t)); err != nil {
		return err
	}
	return a.renderTask(ctx, st, t)
}
