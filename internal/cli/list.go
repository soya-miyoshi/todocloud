package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

// filterFlags are the selection flags of `tdo ls`. They are a function rather
// than a variable because a perspective parses the same set a second time,
// and a flag value must not be shared between the two parses.
func filterFlags() []ucli.Flag {
	return []ucli.Flag{
		&ucli.BoolFlag{Name: "available", Usage: "keep only items that can be worked on now (the default)"},
		&ucli.BoolFlag{Name: "blocked", Usage: "keep only items something is holding back"},
		&ucli.BoolFlag{Name: "deferred", Usage: "keep only items waiting for a defer date"},
		&ucli.BoolFlag{Name: "all", Usage: "no availability or status filter: everything but tombstones"},
		&ucli.BoolFlag{Name: "deleted", Usage: "list the items `tdo rm` tombstoned"},
		&ucli.BoolFlag{Name: "inbox", Usage: "keep only loose actions: tasks with no parent"},
		&ucli.BoolFlag{Name: "flagged", Usage: "keep only flagged items"},
		&ucli.StringFlag{Name: "project", Usage: "keep what is inside project `P`"},
		&ucli.StringFlag{Name: "under", Usage: "keep what is inside `REF`, at any depth"},
		&ucli.StringFlag{Name: "kind", Usage: "keep one `KIND`: folder, project or task"},
		&ucli.StringSliceFlag{Name: "status", Usage: "keep one `STATUS`: active, on_hold, done or dropped; may be repeated"},
		&ucli.StringSliceFlag{Name: "tag", Usage: "require these `TAGS`; may be repeated"},
		&ucli.BoolFlag{Name: "untagged", Usage: "keep only items carrying no tag"},
		&ucli.StringFlag{Name: "due-before", Usage: "keep items due before `D`"},
		&ucli.StringFlag{Name: "defer-before", Usage: "keep items deferred until before `D`"},
		&ucli.StringFlag{Name: "estimate-under", Usage: "keep items estimated under `D`, for example 30m"},
		&ucli.IntFlag{Name: "priority", Usage: "keep items at or above this priority `N`"},
		&ucli.StringSliceFlag{Name: "where", Usage: "require a field to equal a value, `KEY=VALUE`; may be repeated"},
		&ucli.IntFlag{Name: "limit", Usage: "stop after `N` matching items"},
		&ucli.StringFlag{Name: "sort", Usage: "sort by `position`, created, updated, due, defer or title"},
	}
}

// filterFlagNames are the names a saved perspective already decides. Passing
// one alongside --perspective is a usage error rather than a silent merge:
// running a perspective is meant to be exactly equivalent to typing its
// filter, and a half-overridden filter is neither.
var filterFlagNames = []string{
	"available", "blocked", "deferred", "all", "deleted", "inbox", "flagged",
	"project", "under", "kind", "status", "tag", "untagged",
	"due-before", "defer-before", "estimate-under", "priority", "where",
}

// selection is a listing request plus the one thing the shared layer has no
// business knowing: whether the table shows the nesting.
type selection struct {
	taskops.Selection
	tree bool
}

// parseSelection reads the filter flags. It resolves --project and --under
// against the store, which is why it needs one.
func (a *app) parseSelection(ctx context.Context, cmd *ucli.Command, st store.Store) (*selection, error) {
	s := &selection{tree: cmd.Bool("tree")}
	f := store.Filter{}

	chosen := 0
	for _, name := range []string{"available", "blocked", "deferred", "all"} {
		if cmd.Bool(name) {
			chosen++
		}
	}
	if chosen > 1 {
		return nil, usagef("--available, --blocked, --deferred and --all select different sets; pass only one")
	}

	statuses, err := parseStatuses(cmd.StringSlice("status"))
	if err != nil {
		return nil, err
	}

	switch {
	case cmd.Bool("all"):
		// Everything: `--all` is the escape hatch from every default.
	case cmd.Bool("blocked"):
		f.Availability = store.AvailabilityBlocked
		f.Statuses = taskops.OpenStatuses()
	case cmd.Bool("deferred"):
		f.Availability = store.AvailabilityDeferred
		f.Statuses = taskops.OpenStatuses()
	case len(statuses) > 0:
		// An explicit status is an explicit question — "what did I drop?" —
		// and answering it with the availability default would return
		// nothing, since a dropped item is never available.
		f.Statuses = statuses
		if cmd.Bool("available") {
			f.Availability = store.AvailabilityAvailable
		}
	default:
		// The default of §4.1: what can be worked on now. The command layer
		// decides this, not the store.
		f.Availability = store.AvailabilityAvailable
		f.Statuses = taskops.OpenStatuses()
	}
	if len(statuses) > 0 {
		f.Statuses = statuses
	}

	if cmd.Bool("deleted") {
		// A tombstone is never available, so asking for both would always be
		// empty; --deleted therefore drops the availability default too.
		f.OnlyDeleted = true
		f.Availability = store.AvailabilityAny
		if len(statuses) == 0 {
			f.Statuses = nil
		}
	}

	if cmd.IsSet("kind") {
		kind := task.Kind(strings.TrimSpace(cmd.String("kind")))
		if !kind.Valid() {
			return nil, usagef("--kind expects folder, project or task, got %q", cmd.String("kind"))
		}
		f.Kinds = []task.Kind{kind}
	}
	if cmd.Bool("flagged") {
		flagged := true
		f.Flagged = &flagged
	}
	if cmd.Bool("inbox") {
		f.Scope.Inbox = true
	}

	if cmd.IsSet("project") && cmd.IsSet("under") {
		return nil, usagef("--project and --under both choose a subtree; pass only one")
	}
	if ref := strings.TrimSpace(cmd.String("project")); ref != "" {
		p, err := a.resolveContainer(ctx, st, ref, task.KindProject)
		if err != nil {
			return nil, err
		}
		f.Scope.Subtree = p.ID
	}
	if ref := strings.TrimSpace(cmd.String("under")); ref != "" {
		under, err := a.resolveRef(ctx, st, ref)
		if err != nil {
			return nil, err
		}
		f.Scope.Subtree = under.ID
	}

	f.Tags = parseTags(cmd.StringSlice("tag"))
	s.Untagged = cmd.Bool("untagged")
	if s.Untagged && len(f.Tags) > 0 {
		return nil, usagef("--untagged and --tag ask for opposite things")
	}

	if cmd.IsSet("due-before") {
		at, err := parseBound(cmd.String("due-before"))
		if err != nil {
			return nil, err
		}
		f.DueBefore = at
	}
	if cmd.IsSet("defer-before") {
		at, err := parseBound(cmd.String("defer-before"))
		if err != nil {
			return nil, err
		}
		f.DeferBefore = at
	}
	if cmd.IsSet("estimate-under") {
		minutes, err := parseMinutes(cmd.String("estimate-under"))
		if err != nil {
			return nil, err
		}
		if minutes <= 0 {
			return nil, usagef("--estimate-under expects a positive duration, for example 30m")
		}
		s.MaxMinutes = minutes
	}

	order, byTitle, err := parseOrder(cmd.String("sort"))
	if err != nil {
		return nil, err
	}
	f.Order = order
	s.ByTitle = byTitle

	cond, err := listCondition(cmd)
	if err != nil {
		return nil, err
	}
	s.Cond = cond

	limit := cmd.Int("limit")
	if limit < 0 {
		return nil, usagef("--limit must not be negative")
	}
	s.Limit = int(limit)

	if err := f.Validate(); err != nil {
		return nil, exit.Usagef(err)
	}
	s.Filter = f
	return s, nil
}

// parseStatuses reads the repeated --status flag.
func parseStatuses(values []string) ([]task.Status, error) {
	out := make([]task.Status, 0, len(values))
	seen := make(map[task.Status]bool, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			s := task.Status(strings.TrimSpace(part))
			if s == "" {
				continue
			}
			if !s.Valid() {
				return nil, usagef("--status expects active, on_hold, done or dropped, got %q", part)
			}
			if seen[s] {
				continue
			}
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

// parseBound reads a --due-before / --defer-before value. A date-only bound
// means the whole of that day is still in range, so `--due-before 2026-11-01`
// does not drop what is due on the first.
func parseBound(raw string) (*time.Time, error) {
	trimmed := strings.TrimSpace(raw)
	at, err := task.ParseDue(trimmed)
	if err != nil {
		return nil, exit.Usagef(err)
	}
	if len(trimmed) == len(task.DueDateFormat) {
		at = at.Add(24 * time.Hour)
	}
	return &at, nil
}

// parseOrder maps --sort onto a store order. Title is sorted here instead,
// because a collation is not something every provider would agree on.
func parseOrder(value string) (store.Order, bool, error) {
	switch strings.TrimSpace(value) {
	case "", "position":
		return store.OrderPosition, false, nil
	case "created":
		return store.OrderCreated, false, nil
	case "updated":
		return store.OrderUpdated, false, nil
	case "due":
		return store.OrderDue, false, nil
	case "defer":
		return store.OrderDefer, false, nil
	case "title":
		return store.OrderPosition, true, nil
	default:
		return "", false, usagef("--sort expects position, created, updated, due, defer or title, got %q", value)
	}
}

// parseMinutes reads a duration in the spelling the flags accept. The
// spelling is the shared layer's, so --estimate and the API agree.
func parseMinutes(raw string) (int, error) {
	minutes, err := taskops.ParseMinutes(raw)
	if err != nil {
		return 0, exit.Usagef(err)
	}
	return minutes, nil
}

// listCondition builds the client-side filter over the user-defined fields.
// These cannot go into store.Filter: a provider that would need a composite
// index for them must still behave exactly like SQLite.
func listCondition(cmd *ucli.Command) (store.Condition, error) {
	var c store.Condition
	if cmd.IsSet("priority") {
		p := int(cmd.Int("priority"))
		if p < 0 || p > 3 {
			return c, usagef("--priority must be between 0 and 3, got %d", p)
		}
		c.MinPriority = p
	}
	for _, raw := range cmd.StringSlice("where") {
		key, value, ok := strings.Cut(raw, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return c, usagef("--where expects KEY=VALUE, got %q", raw)
		}
		if c.Match == nil {
			c.Match = map[string]string{}
		}
		c.Match[key] = value
	}
	return c, nil
}

// runSelection executes a selection through the shared layer, so that a
// listing is the same answer whichever front end asked for it.
func (a *app) runSelection(ctx context.Context, st store.Store, s *selection) ([]*task.Task, error) {
	return taskops.Run(ctx, st, s.Selection)
}

func (a *app) listCommand() *ucli.Command {
	flags := append(filterFlags(),
		&ucli.StringFlag{Name: "perspective", Usage: "run the saved query `NAME` instead of these flags"},
		&ucli.BoolFlag{Name: "tree", Usage: "show the nesting by indenting each item under its parent"},
	)
	return &ucli.Command{
		Name:    "ls",
		Aliases: []string{"list"},
		Usage:   "list items, by default the ones that can be worked on now",
		Flags:   flags,
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			if cmd.Args().Len() > 0 {
				return usagef("ls takes no arguments; did you mean a filter flag?")
			}

			s, err := a.selectionOrPerspective(ctx, cmd, st)
			if err != nil {
				return err
			}
			tasks, err := a.runSelection(ctx, st, s)
			if err != nil {
				return err
			}
			av, err := a.availabilityOf(ctx, st, tasks)
			if err != nil {
				return err
			}

			if a.out.JSON {
				// Machine output never refreshes the short-number cache; see
				// saveListing.
				return a.out.Emit(map[string]any{"tasks": views(tasks, av), "count": len(tasks)})
			}
			// The numbers printed below are only usable because the ids are
			// cached here, in the same order.
			a.saveListing(st, tasks)
			if len(tasks) == 0 {
				// An empty list is not an error, and stdout stays empty.
				a.out.Hintf("Nothing to do here. `tdo ls --all` shows everything, `tdo add <title>` adds one.")
				return nil
			}
			return a.printTable(tasks, av, s.tree)
		}),
	}
}

// selectionOrPerspective reads either the filter flags or a saved query. A
// perspective *is* a stored filter (§3.6), so running one is exactly
// equivalent to typing it — which is why mixing the two is refused.
func (a *app) selectionOrPerspective(ctx context.Context, cmd *ucli.Command, st store.Store) (*selection, error) {
	name := strings.TrimSpace(cmd.String("perspective"))
	if name == "" {
		return a.parseSelection(ctx, cmd, st)
	}
	for _, flag := range filterFlagNames {
		if cmd.IsSet(flag) {
			return nil, usagef("--perspective %s already decides the filter; --%s would contradict it", name, flag)
		}
	}
	p, err := st.Perspective(ctx, name)
	if err != nil {
		return nil, err
	}
	f := p.Filter
	if err := f.Validate(); err != nil {
		// A perspective saved by a newer binary, or edited by hand, is a
		// usage error at the point it is read rather than a listing that
		// quietly means something else.
		return nil, exit.Usagef(fmt.Errorf("perspective %q: %w", name, err))
	}
	s := &selection{Selection: taskops.Selection{Filter: f, Limit: int(cmd.Int("limit"))}, tree: cmd.Bool("tree")}
	if s.Limit < 0 {
		return nil, usagef("--limit must not be negative")
	}
	order, byTitle, err := parseOrder(cmd.String("sort"))
	if err != nil {
		return nil, err
	}
	if cmd.IsSet("sort") {
		s.Filter.Order = order
		s.ByTitle = byTitle
	}
	return s, nil
}

func (a *app) nextCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "next",
		Usage: "print the first action that can be worked on",
		Flags: []ucli.Flag{
			&ucli.StringFlag{Name: "project", Usage: "look only inside project `P`"},
		},
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			if cmd.Args().Len() > 0 {
				return usagef("next takes no arguments; pass --project to narrow it")
			}
			f := store.Filter{
				Kinds:        []task.Kind{task.KindTask},
				Statuses:     []task.Status{task.StatusActive},
				Availability: store.AvailabilityAvailable,
				Order:        store.OrderPosition,
				Limit:        1,
			}
			if ref := strings.TrimSpace(cmd.String("project")); ref != "" {
				p, err := a.resolveContainer(ctx, st, ref, task.KindProject)
				if err != nil {
					return err
				}
				f.Scope.Subtree = p.ID
			}
			tasks, err := st.List(ctx, f)
			if err != nil {
				return err
			}
			if len(tasks) == 0 {
				if a.out.JSON {
					// The same shape as a listing that found something, so
					// a caller reads `.tasks[0]` either way rather than
					// having to tell null from an object.
					return a.out.Emit(map[string]any{"tasks": []any{}, "count": 0})
				}
				a.out.Hintf("Nothing is available. `tdo ls --blocked` says what is in the way.")
				return nil
			}
			return a.renderTask(ctx, st, tasks[0])
		}),
	}
}

func (a *app) inboxCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "inbox",
		Usage:     "list the tasks that have not been filed anywhere",
		ArgsUsage: "[process <ref> --project P]",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{Name: "count", Usage: "print only how many items are waiting"},
			&ucli.StringFlag{Name: "project", Usage: "file the item into project `P`"},
			&ucli.StringFlag{Name: "parent", Usage: "file the item under `REF`"},
		},
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) > 0 && args[0] == "process" {
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.inboxProcess(ctx, cmd, st, args[1:])
				})
			}
			if len(args) > 0 {
				return usagef("inbox takes no arguments, or `inbox process <ref> --project P`")
			}
			return a.withStore(ctx, func(st store.Store) error {
				return a.inboxList(ctx, cmd, st)
			})
		}),
	}
}

// inboxList is a pure read: the inbox is the absence of a container, so it
// has nothing to create and nothing to refresh.
func (a *app) inboxList(ctx context.Context, cmd *ucli.Command, st store.Store) error {
	if cmd.IsSet("project") || cmd.IsSet("parent") {
		return usagef("--project and --parent belong to `tdo inbox process <ref>`")
	}
	// Availability is not the question here: an inbox item is unfiled
	// whether or not it is deferred, and hiding it would hide the work.
	tasks, err := st.List(ctx, store.Filter{
		Scope:    store.Scope{Inbox: true},
		Statuses: taskops.OpenStatuses(),
		Order:    store.OrderPosition,
	})
	if err != nil {
		return err
	}
	if cmd.Bool("count") {
		if a.out.JSON {
			return a.out.Emit(map[string]any{"count": len(tasks)})
		}
		a.out.Printf("%s\n", countLine(len(tasks), "item in the inbox", "items in the inbox"))
		return nil
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
		a.out.Hintf("The inbox is empty.")
		return nil
	}
	return a.printTable(tasks, av, false)
}

// inboxProcess files one captured item, which is the one write `tdo inbox`
// has. Filing is deliberately a separate command from capture: the cost of
// deciding where something goes must not be charged at the moment of capture
// (§4.1).
func (a *app) inboxProcess(ctx context.Context, cmd *ucli.Command, st store.Store, args []string) error {
	if len(args) != 1 {
		return usagef("inbox process expects exactly one item reference")
	}
	if cmd.Bool("count") {
		return usagef("--count belongs to `tdo inbox`, not to `tdo inbox process`")
	}
	project := strings.TrimSpace(cmd.String("project"))
	parent := strings.TrimSpace(cmd.String("parent"))
	if (project == "") == (parent == "") {
		return usagef("inbox process expects exactly one of --project or --parent")
	}
	t, err := a.resolveRef(ctx, st, args[0])
	if err != nil {
		return err
	}

	var target *task.Task
	if project != "" {
		target, err = a.resolveContainer(ctx, st, project, task.KindProject)
	} else {
		target, err = a.resolveRef(ctx, st, parent)
	}
	if err != nil {
		return err
	}
	if err := treeError(st.Move(ctx, t.ID, target.ID, t.Position, time.Now().UTC())); err != nil {
		return err
	}
	moved, err := st.Get(ctx, t.ID)
	if err != nil {
		return err
	}
	return a.renderTask(ctx, st, moved)
}
