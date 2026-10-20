package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// tagCommand lists tags and changes what a tag is, rather than which tasks
// carry it: `tdo add --tag` and `tdo edit --tag` do the latter.
//
// A tag has a status of its own, and a tag that is not active holds back
// every item filed under it (§3.3). That is what a context nobody can act in
// is for — the errands that cannot happen until the car is back are not
// deferred to a date and not on hold one by one; the context is.
//
// Tags are named, never numbered. The short numbers of a listing belong to
// the last listing of *items* (§3.7), and giving tags a second, parallel set
// of numbers is how `tdo project 1` came to mean a folder: a tag is unique by
// name, so the name is the reference.
func (a *app) tagCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "tag",
		Usage:     "list tags, or put one on hold, drop it, rename it or remove it",
		ArgsUsage: "ls | hold <tag...> | unhold <tag...> | drop <tag...> | rename <old> <new> | rm <tag...>",
		Flags: []ucli.Flag{
			&ucli.StringSliceFlag{Name: "status", Usage: "keep one `STATUS`; may be repeated"},
			&ucli.BoolFlag{Name: "unused", Usage: "list only the tags no live task carries"},
		},
		Action: a.action(func(ctx context.Context, cmd *ucli.Command) error {
			args := cmd.Args().Slice()
			if len(args) == 0 {
				return usagef("tag expects `ls`, `hold`, `unhold`, `drop`, `rename` or `rm`")
			}
			verb, rest := args[0], args[1:]
			if verb != "ls" && verb != "list" {
				if cmd.IsSet("status") {
					return usagef("--status filters `tdo tag ls`; `tdo tag hold`, `unhold` and `drop` set the status")
				}
				if cmd.IsSet("unused") {
					return usagef("--unused filters `tdo tag ls`")
				}
			}
			switch verb {
			case "ls", "list":
				if len(rest) > 0 {
					return usagef("tag ls takes no arguments")
				}
				return a.withStore(ctx, func(st store.Store) error { return a.tagList(ctx, cmd, st) })
			case "hold":
				return a.tagSetStatus(ctx, rest, task.StatusOnHold)
			case "unhold", "activate":
				return a.tagSetStatus(ctx, rest, task.StatusActive)
			case "drop":
				return a.tagSetStatus(ctx, rest, task.StatusDropped)
			case "rename":
				if len(rest) != 2 {
					return usagef("tag rename expects the old name and the new one")
				}
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.tagRename(ctx, st, rest[0], rest[1])
				})
			case "rm", "remove":
				if len(rest) == 0 {
					return usagef("tag rm expects at least one tag")
				}
				return a.withStore(ctx, func(st store.Store) error {
					a.noticeOverriddenStore(st)
					return a.tagRemove(ctx, st, rest)
				})
			default:
				return usagef("tag expects `ls`, `hold`, `unhold`, `drop`, `rename` or `rm`, got %q", verb)
			}
		}),
	}
}

// tagList is `tdo tag ls`: every tag, its status and how many live tasks
// carry it. A tag with a status of its own is listed at zero as well, because
// a context put on hold must not disappear when its last task is finished.
func (a *app) tagList(ctx context.Context, cmd *ucli.Command, st store.Store) error {
	statuses, err := parseStatuses(cmd.StringSlice("status"))
	if err != nil {
		return err
	}
	for _, s := range statuses {
		if !store.ValidTagStatus(s) {
			return usagef("a tag is never %s; its status is active, on_hold or dropped", s)
		}
	}
	tags, err := st.Tags(ctx)
	if err != nil {
		return err
	}
	kept := make([]store.Tag, 0, len(tags))
	for _, tag := range tags {
		if len(statuses) > 0 && !containsStatus(statuses, tag.Status) {
			continue
		}
		if cmd.Bool("unused") && tag.Count > 0 {
			continue
		}
		kept = append(kept, tag)
	}
	return a.renderTags(kept, nil)
}

// tagSetStatus is `tdo tag hold|unhold|drop`. The tags need not be in use:
// putting a context on hold before filing anything under it is ordinary, and
// the row that holds the status is created on demand.
func (a *app) tagSetStatus(ctx context.Context, names []string, status task.Status) error {
	if len(names) == 0 {
		return usagef("expected at least one tag")
	}
	wanted, err := tagNames(names)
	if err != nil {
		return err
	}
	return a.withStore(ctx, func(st store.Store) error {
		a.noticeOverriddenStore(st)
		now := time.Now().UTC()
		for _, name := range wanted {
			if err := st.SetTagStatus(ctx, name, status, now); err != nil {
				return err
			}
		}
		return a.renderTagsNamed(ctx, st, wanted, nil)
	})
}

// tagRename moves every task from one tag to another. The destination keeps
// its own status when it already has one.
func (a *app) tagRename(ctx context.Context, st store.Store, from, to string) error {
	names, err := tagNames([]string{from, to})
	if err != nil {
		return err
	}
	if len(names) != 2 {
		return usagef("tag rename expects two different names, or one name in another spelling")
	}
	if err := st.RenameTag(ctx, names[0], names[1], time.Now().UTC()); err != nil {
		return err
	}
	return a.renderTagsNamed(ctx, st, names[1:], nil)
}

// tagRemove takes tags off every task that carries them. The tasks keep
// everything else; a tag is a label, so there is nothing to tombstone.
func (a *app) tagRemove(ctx context.Context, st store.Store, names []string) error {
	wanted, err := tagNames(names)
	if err != nil {
		return err
	}
	untagged := 0
	for _, name := range wanted {
		n, err := st.RemoveTag(ctx, name)
		if err != nil {
			return err
		}
		untagged += n
	}
	if a.out.JSON {
		return a.out.Emit(map[string]any{"removed": wanted, "count": len(wanted), "untagged": untagged})
	}
	a.out.Printf("removed %s from %d task(s)", strings.Join(wanted, ", "), untagged)
	return nil
}

// renderTagsNamed reports the tags whose names were just written, read back
// from the store so the output is what is stored and not what was asked for.
func (a *app) renderTagsNamed(ctx context.Context, st store.Store, names []string, extra map[string]any) error {
	all, err := st.Tags(ctx)
	if err != nil {
		return err
	}
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		wanted[store.TagKey(name)] = true
	}
	kept := make([]store.Tag, 0, len(names))
	for _, tag := range all {
		if wanted[store.TagKey(tag.Name)] {
			kept = append(kept, tag)
		}
	}
	return a.renderTags(kept, extra)
}

// renderTags writes the tag listing shape, {"tags":[…],"count":n}, or a small
// table. The shape is the tags' own: a tag is not a task and does not pretend
// to be one.
func (a *app) renderTags(tags []store.Tag, extra map[string]any) error {
	if a.out.JSON {
		payload := map[string]any{"tags": tags, "count": len(tags)}
		for k, v := range extra {
			payload[k] = v
		}
		return a.out.Emit(payload)
	}
	if len(tags) == 0 {
		a.out.Hintf("No tags yet. `tdo add <title> --tag home` creates one.")
		return nil
	}
	for _, tag := range tags {
		status := ""
		if tag.Status != task.StatusActive {
			status = "  [" + string(tag.Status) + "]"
		}
		a.out.Printf("%-24s %4d%s", tag.Name, tag.Count, status)
	}
	return nil
}

// tagNames trims and de-duplicates the tags named on the command line,
// keeping the spelling the user typed. A tag may not be a comma-separated
// list here: `tdo tag hold home,errand` would otherwise put a single tag
// called "home,errand" on hold, which is not what anyone means.
func tagNames(args []string) ([]string, error) {
	out := make([]string, 0, len(args))
	seen := make(map[string]bool, len(args))
	for _, raw := range args {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, usagef("a tag must have a name")
		}
		if strings.Contains(name, ",") {
			return nil, usagef("name one tag at a time: %q looks like a list", name)
		}
		key := store.TagKey(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, name)
	}
	if len(out) == 0 {
		return nil, usagef("expected at least one tag")
	}
	return out, nil
}

func containsStatus(statuses []task.Status, s task.Status) bool {
	for _, want := range statuses {
		if want == s {
			return true
		}
	}
	return false
}
