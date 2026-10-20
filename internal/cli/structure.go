package cli

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
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
		statuses = taskops.OpenStatuses()
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

// reshapeFlags are the flags `tdo project <ref>` applies. Everything else the
// command declares belongs to `project add` or `project ls`, and a flag that
// is set but not applied is a usage error rather than a silent no-op: exit 0
// with nothing changed is the worst of the three possible answers.
var reshapeFlags = map[string]bool{
	"sequential":         true,
	"parallel":           true,
	"complete-with-last": true,
	"review":             true,
	"folder":             true,
}

// elsewhere says where a flag `tdo project <ref>` does not apply does work,
// so the error is a redirection and not just a refusal.
var elsewhere = map[string]string{
	"needs-review": "`tdo project ls --needs-review`",
	"status":       "`tdo project ls --status` and `tdo edit <ref> --status`",
	"note":         "`tdo project add --note` and `tdo edit <ref> --note`",
	"notes":        "`tdo project add --note` and `tdo edit <ref> --note`",
	"tag":          "`tdo project add --tag` and `tdo edit <ref> --tag`",
	"defer":        "`tdo project add --defer` and `tdo defer <ref> <date>`",
	"due":          "`tdo project add --due` and `tdo due <ref> <date>`",
	"flag":         "`tdo project add --flag` and `tdo flag <ref>`",
	"estimate":     "`tdo project add --estimate` and `tdo edit <ref> --estimate`",
	"priority":     "`tdo project add --priority` and `tdo edit <ref> --priority`",
	"set":          "`tdo project add --set` and `tdo edit <ref> --set`",
}

// rejectUnappliedFlags refuses a command line that asks for something this
// code path does not do. It exists because every flag the command declares is
// visible in `--help` at every position, and a user who reads it there has no
// way to know which ones this verb reads.
//
// The flags are named rather than read off the command, because a command
// also carries the global ones — `--json` is set far more often than any of
// these and applies everywhere. A flag added to `tdo project` and listed in
// neither map fails TestEveryProjectFlagIsAppliedOrRedirected instead of
// being quietly ignored here.
func rejectUnappliedFlags(cmd *ucli.Command, applied map[string]bool) error {
	names := make([]string, 0, len(elsewhere))
	for name := range elsewhere {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if applied[name] || !cmd.IsSet(name) {
			continue
		}
		return usagef("`tdo project <ref>` does not apply --%s; it is set by %s", name, elsewhere[name])
	}
	return nil
}

// projectReshape is `tdo project <ref>`: with no flags it shows the project,
// and with them it changes how its children behave and which folder it is in.
//
// The reference must name a project. It used to accept a folder as well,
// which meant `tdo project 1 --sequential` run after `tdo folder ls` made a
// *folder* sequential and said nothing about it — the numbers are the last
// listing's, so the same `1` means different things at different moments
// (§3.7). A reference that resolves to the wrong kind is now an error, and a
// change that goes through says what it resolved to.
func (a *app) projectReshape(ctx context.Context, cmd *ucli.Command, st store.Store, ref string) error {
	found, err := a.resolveContainer(ctx, st, ref, task.KindProject)
	if err != nil {
		return err
	}
	if err := rejectUnappliedFlags(cmd, reshapeFlags); err != nil {
		return err
	}
	changed := cmd.IsSet("sequential") || cmd.IsSet("parallel") ||
		cmd.IsSet("complete-with-last") || cmd.IsSet("review") || cmd.IsSet("folder")
	if !changed {
		return a.renderTask(ctx, st, found)
	}
	if cmd.Bool("sequential") && cmd.Bool("parallel") {
		return usagef("--sequential and --parallel ask for opposite things")
	}

	// Both references are resolved before anything is written, so a reshape
	// that cannot be carried out changes nothing and says nothing.
	var folder *task.Task
	if cmd.IsSet("folder") {
		if folder, err = a.resolveFolder(ctx, cmd, st, found); err != nil {
			return err
		}
	}

	a.noticeOverriddenStore(st)
	// A number is read off whichever listing came last, so a reshape says
	// which item it landed on before it changes anything.
	a.out.Hintf("%s → %s", ref, resolvedName(found))
	if cmd.IsSet("folder") {
		if err := a.moveToFolder(ctx, st, found, folder); err != nil {
			return err
		}
		if found, err = st.Get(ctx, found.ID); err != nil {
			return err
		}
	}
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

// resolveFolder reads --folder: the folder a project is being filed into, or
// nil for an empty value, which is the top level.
func (a *app) resolveFolder(ctx context.Context, cmd *ucli.Command, st store.Store, t *task.Task) (*task.Task, error) {
	ref := strings.TrimSpace(cmd.String("folder"))
	if ref == "" {
		return nil, nil
	}
	folder, err := a.resolveContainer(ctx, st, ref, task.KindFolder)
	if err != nil {
		return nil, err
	}
	if folder.ID == t.ID {
		return nil, usagef("a project cannot be put inside itself")
	}
	return folder, nil
}

// moveToFolder is `tdo project <ref> --folder F`: filing an existing project
// into a folder, or out to the top level with an empty --folder. It was
// accepted and silently ignored before, which is why it is a move and not an
// error: the flag is on the command, so it has to mean something.
func (a *app) moveToFolder(ctx context.Context, st store.Store, t, folder *task.Task) error {
	var parentID string
	if folder != nil {
		parentID = folder.ID
	}
	if parentID == t.ParentID {
		return nil
	}
	return treeError(st.Move(ctx, t.ID, parentID, t.Position, time.Now().UTC()))
}

// resolvedName renders what a reference turned out to mean, for the line a
// reshape prints before it writes: the kind, the title and a short id, which
// is enough to tell two similarly numbered items apart.
func resolvedName(t *task.Task) string {
	short := t.ID
	if len(short) > 8 {
		short = short[:8]
	}
	return fmt.Sprintf("%s %q (%s)", t.Kind, t.Title, short)
}
