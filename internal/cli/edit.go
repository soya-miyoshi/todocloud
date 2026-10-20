package cli

import (
	"context"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

func (a *app) editCommand() *ucli.Command {
	flags := append([]ucli.Flag{
		&ucli.StringFlag{Name: "title", Usage: "replace the title with `S`"},
		&ucli.StringFlag{Name: "note", Aliases: []string{"notes"}, Usage: "replace the note with `S`"},
		&ucli.StringFlag{Name: "estimate", Usage: "how long it will take, for example `25m`"},
		&ucli.StringSliceFlag{Name: "tag", Usage: "replace the tags with these `TAGS`; may be repeated"},
		&ucli.StringSliceFlag{Name: "untag", Usage: "remove one `TAG`; may be repeated"},
		&ucli.StringSliceFlag{Name: "unset", Usage: "remove a user-defined field by `KEY`; may be repeated"},
	}, setFlags()...)

	return &ucli.Command{
		Name:      "edit",
		Usage:     "change an item's title, note, estimate, tags or own fields",
		ArgsUsage: "<ref>",
		Flags:     flags,
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			if len(args) != 1 {
				return usagef("edit expects exactly one item reference")
			}
			found, err := a.resolveRef(ctx, st, args[0])
			if err != nil {
				return err
			}
			e, err := editFromFlags(cmd)
			if err != nil {
				return err
			}
			// The shared layer edits a copy, so a rejected change leaves
			// the stored item exactly as it was, and what it rejects
			// classifies as a usage error (taskops.ErrInvalid).
			res, err := taskops.Apply(ctx, st, []*task.Task{found}, e, time.Now().UTC())
			if err != nil {
				return treeError(err)
			}
			return a.renderTask(ctx, st, res.Tasks[0])
		}),
	}
}

// editFromFlags reads the edit flags into the shared change description, so
// that `tdo edit` and `tdo serve` apply the same request the same way.
func editFromFlags(cmd *ucli.Command) (taskops.Edit, error) {
	var e taskops.Edit
	if cmd.IsSet("title") {
		title := cmd.String("title")
		e.Title = &title
	}
	if cmd.IsSet("note") {
		note := cmd.String("note")
		e.Note = &note
	}
	if cmd.IsSet("estimate") {
		minutes, err := parseMinutes(cmd.String("estimate"))
		if err != nil {
			return e, err
		}
		e.EstimatedMinutes = &minutes
	}
	if cmd.IsSet("tag") {
		// --tag replaces the set, which is what "these are its tags" means;
		// --untag is the way to remove one of several.
		tags := cmd.StringSlice("tag")
		e.Tags = &tags
	}
	if cmd.IsSet("untag") {
		e.Untag = cmd.StringSlice("untag")
	}
	priority, set, unset, err := fieldFlags(cmd)
	if err != nil {
		return e, err
	}
	e.Priority, e.Set, e.Unset = priority, set, unset
	return e, nil
}
