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

func (a *app) repeatCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "repeat",
		Usage:     "make an item repeat, or end its series",
		ArgsUsage: "<ref> <every>[:method] | <ref> --stop",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "stop",
				Usage: "end the series, leaving its history in place",
			},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			stop := cmd.Bool("stop")
			switch {
			case stop && len(args) != 1:
				return usagef("repeat --stop expects exactly one item reference")
			case !stop && len(args) != 2:
				return usagef("repeat expects an item reference and an interval, for example `tdo repeat 3 1w`")
			}

			found, err := a.resolveRef(ctx, st, args[0])
			if err != nil {
				return err
			}
			t := found.Clone()
			if stop {
				// The series id stays: the instances already completed are
				// still one series, and `tdo series` must keep finding them.
				t.Repeat = nil
			} else {
				r, err := parseRepeat(args[1])
				if err != nil {
					return err
				}
				t.Repeat = r
				recur.EnsureSeries(t)
			}
			t.UpdatedAt = time.Now().UTC()
			if err := t.Validate(); err != nil {
				return exit.Usagef(err)
			}
			if err := treeError(st.Update(ctx, t)); err != nil {
				return err
			}
			return a.renderTask(ctx, st, t)
		}),
	}
}

func (a *app) seriesCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "series",
		Usage:     "list every instance of one repeating item",
		ArgsUsage: "<ref>",
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			if len(args) != 1 {
				return usagef("series expects exactly one item reference")
			}
			found, err := a.resolveRef(ctx, st, args[0])
			if err != nil {
				return err
			}
			seriesID := found.SeriesID
			if seriesID == "" {
				// An item that has never repeated is a series of one, which
				// is a truthful answer rather than an error.
				seriesID = found.ID
			}

			// store.Filter has no series key, so the instances are picked out
			// here. They are every status, including deleted: the point of
			// looking at a series is to see its history.
			all, err := st.List(ctx, store.Filter{IncludeDeleted: true, Order: store.OrderCreated})
			if err != nil {
				return err
			}
			instances := make([]*task.Task, 0, 4)
			for _, t := range all {
				switch {
				case t.SeriesID == seriesID, t.ID == seriesID && t.SeriesID == "":
					instances = append(instances, t)
				}
			}

			av, err := a.availabilityOf(ctx, st, instances)
			if err != nil {
				return err
			}
			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"series_id": seriesID,
					"tasks":     views(instances, av),
					"count":     len(instances),
				})
			}
			a.saveListing(st, instances)
			return a.printTable(instances, av, false)
		}),
	}
}

func (a *app) reviewCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "review",
		Usage:     "list the folders and projects due for review, or mark one reviewed",
		ArgsUsage: "[<ref>]",
		Flags: []ucli.Flag{
			&ucli.StringFlag{Name: "interval", Usage: "also set the review interval to `EVERY`"},
		},
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) > 1 {
				return usagef("review expects at most one item reference")
			}
			if len(args) == 0 {
				if cmd.IsSet("interval") {
					return usagef("--interval needs the item to mark reviewed")
				}
				// With no reference this is a pure read (§4.2): it lists
				// what is due and marks nothing.
				return a.withStore(ctx, func(st store.Store) error {
					return a.reviewList(ctx, st)
				})
			}
			return a.withStore(ctx, func(st store.Store) error {
				a.noticeOverriddenStore(st)
				return a.reviewMark(ctx, cmd, st, args[0])
			})
		}),
	}
}

func (a *app) reviewList(ctx context.Context, st store.Store) error {
	now := time.Now().UTC()
	// The bound is exclusive, and an item that has never been reviewed, or
	// whose interval elapsed exactly now, is due now — so the cut is a
	// moment past now rather than now itself.
	cut := now.Add(time.Millisecond)
	tasks, err := st.List(ctx, store.Filter{
		Kinds:           []task.Kind{task.KindFolder, task.KindProject},
		Statuses:        openStatuses(),
		ReviewDueBefore: &cut,
		Order:           store.OrderPosition,
		Now:             now,
	})
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
		a.out.Hintf("Nothing is due for review.")
		return nil
	}
	return a.printTable(tasks, av, false)
}

func (a *app) reviewMark(ctx context.Context, cmd *ucli.Command, st store.Store, ref string) error {
	// Review is about folders and projects, so a reference here may be a
	// title as well as a number or an id prefix.
	found, err := a.resolveContainer(ctx, st, ref, task.KindFolder, task.KindProject)
	if err != nil {
		return err
	}
	t := found.Clone()
	if cmd.IsSet("interval") {
		interval, err := parseReviewInterval(cmd.String("interval"))
		if err != nil {
			return err
		}
		t.ReviewInterval = interval
	}
	recur.MarkReviewed(t, time.Now().UTC())
	if err := t.Validate(); err != nil {
		return exit.Usagef(err)
	}
	if err := treeError(st.Update(ctx, t)); err != nil {
		return err
	}
	return a.renderTask(ctx, st, t)
}

// perspectiveCommand saves, lists, shows and removes saved queries. A
// perspective is a stored store.Filter and nothing else (§3.6): it holds no
// results and pins no ids, so it cannot go stale.
func (a *app) perspectiveCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "perspective",
		Usage:     "save, list, show or remove a saved query",
		ArgsUsage: "save <name> -- <ls flags...> | ls | show <name> | rm <name>",
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) == 0 {
				return usagef("perspective expects `save`, `ls`, `show` or `rm`")
			}
			switch args[0] {
			case "save":
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.perspectiveSave(ctx, st, args[1:])
				})
			case "ls", "list":
				if len(args) > 1 {
					return usagef("perspective ls takes no arguments")
				}
				return a.withStore(ctx, func(st store.Store) error { return a.perspectiveList(ctx, st) })
			case "show":
				if len(args) != 2 {
					return usagef("perspective show expects exactly one name")
				}
				return a.withStore(ctx, func(st store.Store) error { return a.perspectiveShow(ctx, st, args[1]) })
			case "rm", "remove":
				if len(args) != 2 {
					return usagef("perspective rm expects exactly one name")
				}
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.perspectiveRemove(ctx, st, args[1])
				})
			default:
				return usagef("perspective expects `save`, `ls`, `show` or `rm`, got %q", args[0])
			}
		}),
	}
}

// perspectiveSave parses the remaining arguments with the very flag set
// `tdo ls` uses, so that a saved query can express exactly what a command
// line can and nothing else.
func (a *app) perspectiveSave(ctx context.Context, st store.Store, args []string) error {
	if len(args) == 0 {
		return usagef("perspective save expects a name and the `ls` flags to save")
	}
	name := strings.TrimSpace(args[0])
	if name == "" {
		return usagef("a perspective needs a name")
	}

	var saved *selection
	parser := &ucli.Command{
		Name:                      "perspective save",
		Flags:                     filterFlags(),
		DisableSliceFlagSeparator: true,
		OnUsageError:              onUsageError,
		Writer:                    a.env.Stderr,
		ErrWriter:                 a.env.Stderr,
		Action: func(ctx context.Context, parsed *ucli.Command) error {
			if parsed.Args().Len() > 0 {
				return usagef("perspective save takes flags after the name, not arguments: %q", parsed.Args().First())
			}
			s, err := a.parseSelection(ctx, parsed, st)
			if err != nil {
				return err
			}
			saved = s
			return nil
		},
	}
	if err := parser.Run(ctx, append([]string{"perspective save"}, args[1:]...)); err != nil {
		return err
	}
	if saved == nil {
		return usagef("perspective save expects at least one `ls` flag")
	}
	if !saved.cond.Empty() || saved.untagged || saved.maxMinutes > 0 || saved.byTitle {
		// These are evaluated on the client, outside the stored Filter, so
		// saving them would produce a perspective that does not mean what it
		// says when it is run.
		return usagef("--where, --priority, --untagged, --estimate-under and --sort title cannot be saved in a perspective yet")
	}

	f := saved.filter
	f.Limit = saved.limit
	now := time.Now().UTC()
	p := &store.Perspective{Name: name, Filter: f, CreatedAt: now, UpdatedAt: now}
	if err := st.SavePerspective(ctx, p); err != nil {
		return err
	}
	return a.renderPerspective(p)
}

func (a *app) perspectiveList(ctx context.Context, st store.Store) error {
	ps, err := st.Perspectives(ctx)
	if err != nil {
		return err
	}
	if a.out.JSON {
		if ps == nil {
			ps = []*store.Perspective{}
		}
		return a.out.Emit(map[string]any{"perspectives": ps, "count": len(ps)})
	}
	if len(ps) == 0 {
		a.out.Hintf("No perspectives yet. `tdo perspective save <name> -- --flagged` saves one.")
		return nil
	}
	for _, p := range ps {
		a.out.Printf("%s\n", p.Name)
	}
	return nil
}

func (a *app) perspectiveShow(ctx context.Context, st store.Store, name string) error {
	p, err := st.Perspective(ctx, strings.TrimSpace(name))
	if err != nil {
		return err
	}
	return a.renderPerspective(p)
}

func (a *app) perspectiveRemove(ctx context.Context, st store.Store, name string) error {
	trimmed := strings.TrimSpace(name)
	if err := st.DeletePerspective(ctx, trimmed); err != nil {
		return err
	}
	if a.out.JSON {
		return a.out.Emit(map[string]any{"removed": trimmed})
	}
	a.out.Printf("removed %s\n", trimmed)
	return nil
}

func (a *app) renderPerspective(p *store.Perspective) error {
	if a.out.JSON {
		return a.out.Emit(map[string]any{"perspective": p})
	}
	a.out.Printf("%s\n", p.Name)
	return nil
}
