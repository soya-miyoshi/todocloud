package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
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

// applySetFlags writes --priority, --set and --unset into f. --set is applied
// after the sugar flags and --unset after that, so the more explicit flag
// wins when a key is named twice.
func applySetFlags(cmd *ucli.Command, f task.Fields) error {
	if cmd.IsSet("priority") {
		p := int(cmd.Int("priority"))
		if p < 0 || p > 3 {
			return usagef("priority must be between 0 and 3, got %d", p)
		}
		f.Set(task.KeyPriority, p)
	}
	for _, raw := range cmd.StringSlice("set") {
		key, value, ok := strings.Cut(raw, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return usagef("--set expects KEY=VALUE, got %q", raw)
		}
		if task.Reserved(key) {
			return usagef("field %q is reserved and cannot be set", key)
		}
		f.Set(key, task.ParseValue(value))
	}
	for _, key := range cmd.StringSlice("unset") {
		key = strings.TrimSpace(key)
		if key == "" {
			return usagef("--unset expects a field name")
		}
		if task.Reserved(key) {
			return usagef("field %q is reserved and cannot be unset", key)
		}
		f.Delete(key)
	}
	return nil
}

// parseTags splits the comma-separated lists a repeated --tag builds up, drops
// blanks and removes duplicates while keeping the order the user wrote. Tags
// are compared case-insensitively, because that is how they are matched.
func parseTags(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		for _, tag := range strings.Split(value, ",") {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			key := strings.ToLower(tag)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, tag)
		}
	}
	return out
}

// parseRepeat reads `EVERY[:method]`. The interval spelling may itself carry
// a colon ("1mo:last-friday"), so the method is recognised by name at the end
// rather than by position: anything that is not one of the three methods is
// part of the interval.
func parseRepeat(raw string) (*task.Repeat, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, usagef("--repeat expects an interval, for example 1w or 1w:from_completion")
	}
	every := s
	// A repeat with no method named is a calendar schedule: the next instance
	// follows the previous instance's dates, which is what someone writing
	// "every Monday" means. The other two methods are asked for by name.
	method := task.RepeatFixed
	// The interval spelling may itself carry a colon ("1mo:last-friday"), so
	// the method is recognised by name at the end rather than by position.
	if i := strings.LastIndex(s, ":"); i >= 0 {
		if m := task.RepeatMethod(s[i+1:]); m.Valid() {
			every, method = s[:i], m
		}
	}
	if _, err := recur.ParseEvery(every); err != nil {
		return nil, exit.Usagef(err)
	}
	return &task.Repeat{Method: method, Every: every}, nil
}

// newItem builds a task from the flags every creating command shares, and
// places it under the parent the flags name. parent is nil at the top level,
// which for a task means the inbox.
func (a *app) newItem(cmd *ucli.Command, kind task.Kind, title string, parent *task.Task) (*task.Task, error) {
	now := time.Now().UTC()
	t := task.New(id.New(), kind, title, now)
	if parent != nil {
		t.ParentID = parent.ID
	}
	if cmd.IsSet("flag") {
		t.Flagged = cmd.Bool("flag")
	}
	if cmd.IsSet("tag") {
		t.SetTags(parseTags(cmd.StringSlice("tag")))
	}
	if cmd.IsSet("note") {
		t.Note = cmd.String("note")
	}
	if cmd.IsSet("defer") {
		at, err := parseInstant(cmd.String("defer"))
		if err != nil {
			return nil, err
		}
		t.DeferAt = at
	}
	if cmd.IsSet("due") {
		at, err := parseInstant(cmd.String("due"))
		if err != nil {
			return nil, err
		}
		t.DueAt = at
	}
	if cmd.IsSet("estimate") {
		minutes, err := parseMinutes(cmd.String("estimate"))
		if err != nil {
			return nil, err
		}
		t.EstimatedMinutes = minutes
	}
	if cmd.IsSet("repeat") {
		r, err := parseRepeat(cmd.String("repeat"))
		if err != nil {
			return nil, err
		}
		t.Repeat = r
		// The first instance names the series, so a successor can be tied to
		// it without a second generator.
		recur.EnsureSeries(t)
	}
	if err := applySetFlags(cmd, t.Fields); err != nil {
		return nil, err
	}
	if err := t.Validate(); err != nil {
		return nil, exit.Usagef(err)
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
