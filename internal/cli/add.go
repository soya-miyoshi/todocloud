package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

// setFlags are the flags that write user-defined fields. Everything the GTD
// model names is a required field with a flag of its own; --set is what is
// left, and it is stored in the open map untouched.
func setFlags() []ucli.Flag {
	return []ucli.Flag{
		&ucli.IntFlag{
			Name:  "priority",
			Usage: "priority from 0 (none) to 3 (high)",
		},
		&ucli.StringSliceFlag{
			Name:  "set",
			Usage: "set a user-defined field, `KEY=VALUE`; may be repeated",
		},
	}
}

// addFlags are the flags `tdo add` takes beyond the shared ones.
func addFlags() []ucli.Flag {
	return append([]ucli.Flag{
		&ucli.StringFlag{Name: "project", Usage: "put the task in project `P`"},
		&ucli.StringFlag{Name: "parent", Usage: "put the task under `REF`, making an action group"},
		&ucli.BoolFlag{Name: "inbox", Usage: "capture to the inbox, which is the default"},
		&ucli.StringFlag{Name: "defer", Usage: "not available before `D`"},
		&ucli.StringFlag{Name: "due", Usage: "due date, `YYYY-MM-DD` or RFC 3339"},
		&ucli.BoolFlag{Name: "flag", Usage: "flag the new item"},
		&ucli.StringSliceFlag{Name: "tag", Usage: "comma-separated `TAGS`; may be repeated"},
		&ucli.StringFlag{Name: "note", Aliases: []string{"notes"}, Usage: "free-form note"},
		&ucli.StringFlag{Name: "estimate", Usage: "how long it will take, for example `25m`"},
		&ucli.StringFlag{Name: "repeat", Usage: "repeat `EVERY[:method]`, for example 1w or 1mo:last-friday:fixed"},
	}, setFlags()...)
}

// fieldFlags reads --priority, --set and --unset into the three arguments
// the shared layer takes. Parsing the spelling is this package's job; what a
// reserved name means is not, so that `tdo serve` cannot accept a field
// `tdo add` refuses.
func fieldFlags(cmd *ucli.Command) (priority *int, set map[string]any, unset []string, err error) {
	if cmd.IsSet("priority") {
		p := int(cmd.Int("priority"))
		priority = &p
	}
	for _, raw := range cmd.StringSlice("set") {
		key, value, ok := strings.Cut(raw, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, nil, nil, usagef("--set expects KEY=VALUE, got %q", raw)
		}
		if set == nil {
			set = map[string]any{}
		}
		set[key] = task.ParseValue(value)
	}
	for _, key := range cmd.StringSlice("unset") {
		unset = append(unset, key)
	}
	return priority, set, unset, nil
}

// parseTags splits the comma-separated lists a repeated --tag builds up. The
// normalization — blanks, duplicates, case — is the shared layer's.
func parseTags(values []string) []string {
	return taskops.NormalizeTags(values)
}

// parseRepeat reads the --repeat value. What the spelling means is the
// shared layer's, so `tdo add --repeat` and the API accept the same one.
func parseRepeat(raw string) (*task.Repeat, error) {
	r, err := taskops.ParseRepeat(raw)
	if err != nil {
		return nil, exit.Usagef(err)
	}
	return r, nil
}

// newItem builds a task from the flags every creating command shares, and
// places it under the parent the flags name. parent is nil at the top level,
// which for a task means the inbox.
//
// The flags are read here and the item is assembled by the shared layer, so
// that an item created through `tdo serve` is the same row as one created
// here.
func (a *app) newItem(cmd *ucli.Command, kind task.Kind, title string, parent *task.Task) (*task.Task, error) {
	d := taskops.Draft{Kind: kind, Title: title}
	if parent != nil {
		d.ParentID = parent.ID
	}
	if cmd.IsSet("flag") {
		d.Flagged = cmd.Bool("flag")
	}
	if cmd.IsSet("tag") {
		d.Tags = parseTags(cmd.StringSlice("tag"))
	}
	if cmd.IsSet("note") {
		d.Note = cmd.String("note")
	}
	if cmd.IsSet("defer") {
		at, err := parseInstant(cmd.String("defer"))
		if err != nil {
			return nil, err
		}
		d.DeferAt = at
	}
	if cmd.IsSet("due") {
		at, err := parseInstant(cmd.String("due"))
		if err != nil {
			return nil, err
		}
		d.DueAt = at
	}
	if cmd.IsSet("estimate") {
		minutes, err := parseMinutes(cmd.String("estimate"))
		if err != nil {
			return nil, err
		}
		d.EstimatedMinutes = minutes
	}
	if cmd.IsSet("repeat") {
		r, err := parseRepeat(cmd.String("repeat"))
		if err != nil {
			return nil, err
		}
		d.Repeat = r
	}
	priority, set, unset, err := fieldFlags(cmd)
	if err != nil {
		return nil, err
	}
	if len(unset) > 0 {
		return nil, usagef("--unset removes a field from an existing item; a new one has none")
	}
	d.Priority, d.Set = priority, set

	t, err := d.Build(id.New(), time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return t, nil
}

// parseInstant reads a --defer / --due value. A plain date means that day at
// midnight UTC, which is what task.ParseDue returns.
func parseInstant(raw string) (*time.Time, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	at, err := task.ParseDue(trimmed)
	if err != nil {
		return nil, exit.Usagef(err)
	}
	return &at, nil
}

func (a *app) addCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "add",
		Usage:     "capture a task, to the inbox unless it is given a home",
		ArgsUsage: "<title...>",
		Flags:     addFlags(),
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			title := strings.TrimSpace(strings.Join(cmd.Args().Slice(), " "))
			if title == "" {
				return usagef("expected a task title")
			}
			parent, err := a.addParent(ctx, cmd, st)
			if err != nil {
				return err
			}
			t, err := a.newItem(cmd, task.KindTask, title, parent)
			if err != nil {
				return err
			}
			if err := treeError(st.Add(ctx, t)); err != nil {
				return err
			}
			return a.renderTask(ctx, st, t)
		}),
	}
}

// addParent resolves where a new task goes. With neither --project nor
// --parent it goes to the inbox, because the cost of filing must not be
// charged at the moment of capture (§4.1).
func (a *app) addParent(ctx context.Context, cmd *ucli.Command, st store.Store) (*task.Task, error) {
	project := strings.TrimSpace(cmd.String("project"))
	parent := strings.TrimSpace(cmd.String("parent"))
	inbox := cmd.Bool("inbox")

	switch {
	case project != "" && parent != "":
		return nil, usagef("--project and --parent both choose where the task goes; pass only one")
	case inbox && (project != "" || parent != ""):
		return nil, usagef("--inbox means no parent, so it contradicts --project and --parent")
	case project != "":
		return a.resolveContainer(ctx, st, project, task.KindProject)
	case parent != "":
		return a.resolveRef(ctx, st, parent)
	default:
		return nil, nil
	}
}
