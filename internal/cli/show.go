package cli

import (
	"context"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/store"
)

func (a *app) showCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "show",
		Usage:     "show one item in full, including why it is blocked",
		ArgsUsage: "<ref>",
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			if len(args) != 1 {
				return usagef("show expects exactly one item reference")
			}
			t, err := a.resolveRef(ctx, st, args[0])
			if err != nil {
				return err
			}
			// A pure read: show never files, never repeats and never
			// refreshes the short numbers (§4.2).
			return a.renderTask(ctx, st, t)
		}),
	}
}
