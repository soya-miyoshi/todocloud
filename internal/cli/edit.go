package cli

import (
	"context"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/store"
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

			// Edit a copy: the store still holds the value resolveRef
			// returned, and a validation failure must not change anything.
			t := found.Clone()
			if cmd.IsSet("title") {
				t.Title = strings.TrimSpace(cmd.String("title"))
			}
			if cmd.IsSet("note") {
				t.Note = cmd.String("note")
			}
			if cmd.IsSet("estimate") {
				minutes, err := parseMinutes(cmd.String("estimate"))
				if err != nil {
					return err
				}
				t.EstimatedMinutes = minutes
			}
			if cmd.IsSet("tag") {
				// --tag replaces the set, which is what "these are its tags"
				// means; --untag is the way to remove one of several.
				t.SetTags(parseTags(cmd.StringSlice("tag")))
			}
			if cmd.IsSet("untag") {
				remove := parseTags(cmd.StringSlice("untag"))
				kept := make([]string, 0, len(t.Tags))
				for _, tag := range t.Tags {
					drop := false
					for _, unwanted := range remove {
						if strings.EqualFold(tag, unwanted) {
							drop = true
							break
						}
					}
					if !drop {
						kept = append(kept, tag)
					}
				}
				t.SetTags(kept)
			}
			if err := applySetFlags(cmd, t.Fields); err != nil {
				return err
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
