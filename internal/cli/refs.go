package cli

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/shortref"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// shortRefDigits is the longest reference still read as a number from the last
// listing. Six digits is far more rows than anyone lists, and it leaves every
// longer all-digit string to be treated as an id prefix.
const shortRefDigits = 6

// resolveRef turns a reference typed on the command line into a task.
//
// The order is fixed: a short number from the last `tdo ls` first, because
// that is what the user just read off the screen; then an id prefix, so that
// `tdo done 01J3` works like a short commit hash; and otherwise a usage error,
// so a typo is reported as a bad reference rather than as a missing task.
func (a *app) resolveRef(ctx context.Context, st store.Store, ref string) (*task.Task, error) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return nil, usagef("empty task reference")
	}

	if n, ok := shortNumber(trimmed); ok {
		key := st.Describe()
		taskID, found := shortref.Lookup(key, n)
		if !found {
			return nil, notFoundf("no task numbered %d in the last listing; run `tdo ls` first", n)
		}
		a.out.Debugf("reference %q resolved from the last listing", trimmed)
		t, err := st.Get(ctx, taskID)
		if err != nil {
			return nil, err
		}
		return t, nil
	}

	if id.ValidPrefix(trimmed) {
		return st.FindByPrefix(ctx, id.Normalize(trimmed))
	}

	return nil, exit.Usagef(id.ErrBadPrefix(ref))
}

// shortNumber reports whether ref is a short number from the last listing.
func shortNumber(ref string) (int, bool) {
	if ref == "" || len(ref) > shortRefDigits {
		return 0, false
	}
	for _, r := range ref {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(ref)
	if err != nil {
		return 0, false
	}
	return n, true
}

// resolveRefs resolves every reference before the caller changes anything, so
// a command over several tasks either applies to all of them or to none.
func (a *app) resolveRefs(ctx context.Context, st store.Store, refs []string) ([]*task.Task, error) {
	if len(refs) == 0 {
		return nil, usagef("expected at least one task reference")
	}
	seen := make(map[string]bool, len(refs))
	tasks := make([]*task.Task, 0, len(refs))
	for _, ref := range refs {
		t, err := a.resolveRef(ctx, st, ref)
		if err != nil {
			return nil, err
		}
		if seen[t.ID] {
			// The same task named twice (as a number and as a prefix, say) is
			// not an error; applying the change once is what was meant.
			continue
		}
		seen[t.ID] = true
		tasks = append(tasks, t)
	}
	return tasks, nil
}

// saveListing caches the ids of a listing so the printed numbers resolve at
// the next command. A cache that cannot be written is never fatal: the user
// can still use an id prefix, so the failure is a warning under --debug.
//
// Machine output does not update the cache. The numbers are a convenience for
// whoever just read the table, and docs/agents.md tells a machine caller to
// use the id; letting a backgrounded `tdo ls --json` renumber the list under a
// human — or under another agent — would turn a shared file into a race with
// consequences, since `tdo done 2` would then mean a different task.
func (a *app) saveListing(st store.Store, tasks []*task.Task) {
	if a.out.JSON {
		a.out.Debugf("not caching the listing: --json callers reference tasks by id")
		return
	}
	// An empty listing installs no numbers, so overwriting the cache with it
	// is pure loss: `tdo ls` followed by a `tdo review` that finds nothing
	// would leave `tdo done 1` reporting that there is no task 1. A command
	// that found nothing has not told the user to renumber anything.
	if len(tasks) == 0 {
		a.out.Debugf("not caching an empty listing: it would discard the numbers already cached")
		return
	}
	ids := make([]string, 0, len(tasks))
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	if err := shortref.Save(st.Describe(), ids); err != nil {
		a.out.Debugf("could not cache the listing: %v", err)
	}
}

// notFoundError carries a message of its own while still unwrapping to
// store.ErrNotFound, so the user reads one sentence instead of a wrapped
// chain, and exit.Classify still returns the not-found code.
type notFoundError struct{ msg string }

func (e notFoundError) Error() string { return e.msg }

func (e notFoundError) Unwrap() error { return store.ErrNotFound }

// notFoundf builds a not-found error with its own wording.
func notFoundf(format string, args ...any) error {
	return notFoundError{msg: fmt.Sprintf(format, args...)}
}

// resolveContainer resolves a reference that must name a folder or a
// project: the `--project` and `--folder` flags, `tdo inbox process`, and the
// two commands that act on a container by name.
//
// A container is typed far more often than an action — every `tdo add
// --project` names one — so a title is accepted as well as a number or an id
// prefix. The order is the same as everywhere else, with the title tried last
// so that a number never changes meaning.
func (a *app) resolveContainer(ctx context.Context, st store.Store, ref string, kinds ...task.Kind) (*task.Task, error) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return nil, usagef("empty %s reference", kindList(kinds))
	}

	_, numbered := shortNumber(trimmed)
	if numbered || id.ValidPrefix(trimmed) {
		switch t, err := a.resolveRef(ctx, st, trimmed); {
		case err == nil:
			if !containsKind(kinds, t.Kind) {
				return nil, usagef("%s is a %s, not a %s", trimmed, t.Kind, kindList(kinds))
			}
			return t, nil
		case numbered, !errors.Is(err, store.ErrNotFound):
			// A number comes from a listing the user just read, so a miss is
			// a miss; only an id prefix falls through to a title, since most
			// titles are valid base32 by accident.
			return nil, err
		}
	}

	matches, err := st.List(ctx, store.Filter{Kinds: kinds})
	if err != nil {
		return nil, err
	}
	var found *task.Task
	for _, t := range matches {
		if !strings.EqualFold(strings.TrimSpace(t.Title), trimmed) {
			continue
		}
		if found != nil {
			return nil, fmt.Errorf("more than one %s is called %q; use its id: %w", kindList(kinds), trimmed, store.ErrAmbiguous)
		}
		found = t
	}
	if found == nil {
		return nil, notFoundf("no %s called %q; `tdo project ls` and `tdo folder ls` list them", kindList(kinds), trimmed)
	}
	return found, nil
}

func containsKind(kinds []task.Kind, k task.Kind) bool {
	for _, want := range kinds {
		if want == k {
			return true
		}
	}
	return false
}

// kindList names the kinds a reference may have, for an error message.
func kindList(kinds []task.Kind) string {
	parts := make([]string, 0, len(kinds))
	for _, k := range kinds {
		parts = append(parts, string(k))
	}
	return strings.Join(parts, " or ")
}
