package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

func (a *app) removeCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "rm",
		Aliases:   []string{"remove"},
		Usage:     "remove items, writing a tombstone unless --purge is given",
		ArgsUsage: "<ref...>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "recursive",
				Usage: "mean it for a container that still holds items",
			},
			&ucli.BoolFlag{
				Name:  "purge",
				Usage: "delete irreversibly instead of writing a tombstone",
			},
			&ucli.BoolFlag{
				Name:  "yes",
				Usage: "skip the confirmation prompt for --purge",
			},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			tasks, err := a.resolveRefs(ctx, st, cmd.Args().Slice())
			if err != nil {
				return err
			}
			if cmd.Bool("purge") {
				return a.purge(ctx, st, tasks, cmd.Bool("recursive"), cmd.Bool("yes"))
			}
			return a.tombstone(ctx, st, tasks)
		}),
	}
}

// tombstone is the ordinary removal: the item stays in the store with a
// deleted_at stamp, so that a second device can learn about the deletion
// instead of silently resurrecting it.
//
// Removing a container takes its subtree with it. Leaving the children behind
// would make them orphans, which §3.3 refuses to call available — so they
// would vanish from every listing while still being there.
func (a *app) tombstone(ctx context.Context, st store.Store, tasks []*task.Task) error {
	res, err := taskops.Tombstone(ctx, st, tasks, time.Now().UTC())
	if err != nil {
		return err
	}
	return a.renderTasks(ctx, st, res.Tasks, a.report(res.AutoCompleted, nil))
}

// purge is the only irreversible path in the CLI, so it is the only one that
// asks. On a TTY it prompts; without one it refuses rather than assuming
// --yes, because a script or an agent must say so explicitly.
func (a *app) purge(ctx context.Context, st store.Store, tasks []*task.Task, recursive, yes bool) error {
	// What is about to go is counted before anything is asked, so the prompt
	// and the refusal both name the real number of rows.
	going := 0
	for _, t := range tasks {
		subtree, err := st.Subtree(ctx, t.ID)
		if err != nil {
			return err
		}
		if !recursive && len(subtree) > 1 {
			return usagef("%s still holds %d item(s); pass --recursive to purge them too", t.ID, len(subtree)-1)
		}
		if recursive {
			going += len(subtree)
		} else {
			going++
		}
	}

	if !yes {
		if !a.stdinIsTerminal() {
			return usagef("refusing to purge %d item(s) from %s without a terminal to confirm at; pass --yes", going, st.Describe())
		}
		// The prompt names the store: when a provider override is in play,
		// the items about to go are not necessarily the ones on screen a
		// moment ago.
		ok, err := a.confirm(fmt.Sprintf("Permanently delete %d item(s) from %s? This cannot be undone.", going, st.Describe()))
		if err != nil {
			return err
		}
		if !ok {
			// Declining is not a failure; nothing was changed.
			a.out.Hintf("Cancelled; nothing was purged.")
			if a.out.JSON {
				return a.out.Emit(map[string]any{"purged": []string{}, "count": 0})
			}
			return nil
		}
	}

	purged := make([]string, 0, going)
	for _, t := range tasks {
		if recursive {
			subtree, err := st.Subtree(ctx, t.ID)
			if err != nil {
				return err
			}
			if _, err := st.PurgeSubtree(ctx, t.ID); err != nil {
				return err
			}
			for _, node := range subtree {
				purged = append(purged, node.ID)
			}
			continue
		}
		if err := st.Purge(ctx, t.ID); err != nil {
			if errors.Is(err, store.ErrNotEmpty) {
				// A child added between the count above and this call.
				return usagef("%s is not empty; pass --recursive to purge what is inside it", t.ID)
			}
			return err
		}
		purged = append(purged, t.ID)
	}

	if a.out.JSON {
		return a.out.Emit(map[string]any{"purged": purged, "count": len(purged)})
	}
	for _, taskID := range purged {
		a.out.Printf("purged %s\n", taskID)
	}
	return nil
}

// confirm asks on stderr and reads the answer from stdin, so that a prompt
// never lands in piped machine output.
func (a *app) confirm(question string) (bool, error) {
	fmt.Fprintf(a.env.Stderr, "%s [y/N] ", question)
	line, err := bufio.NewReader(a.env.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes", nil
}

// stdinIsTerminal reports whether there is a user at stdin to answer a
// prompt. A character-device check is not enough — /dev/null is one — so this
// asks go-isatty, which is already in the module graph. An injected reader is
// never a terminal, which is what the tests need.
func (a *app) stdinIsTerminal() bool {
	f, ok := a.env.Stdin.(*os.File)
	if !ok {
		return false
	}
	fd := f.Fd()
	return isatty.IsTerminal(fd) || isatty.IsCygwinTerminal(fd)
}
