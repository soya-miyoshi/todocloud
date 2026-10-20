package taskops

import (
	"context"
	"sort"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// OpenStatuses are the statuses "the list" means: the work that is still in
// front of the user. Done and dropped items are what an explicit status
// filter is for. The front end decides this, not the store.
func OpenStatuses() []task.Status {
	return []task.Status{task.StatusActive, task.StatusOnHold}
}

// Selection is a parsed listing request: what the store can filter, what has
// to be filtered here, and how much of the result to keep.
type Selection struct {
	Filter store.Filter
	Cond   store.Condition
	// Untagged and MaxMinutes are the two filters neither store.Filter nor
	// store.Condition covers; they are applied here, after the store's own
	// pass, like every other condition on an open field.
	Untagged   bool
	MaxMinutes int
	// ByTitle sorts the result by title. It is not a store.Order because no
	// provider can be asked for a collation the others would match.
	ByTitle bool
	Limit   int
}

// Run executes a selection: the store filters what it can, this package
// filters the rest, and the limit is applied wherever the filtering ends so
// that it always counts items the caller actually asked to see.
func Run(ctx context.Context, st store.Store, s Selection) ([]*task.Task, error) {
	f := s.Filter
	clientSide := !s.Cond.Empty() || s.Untagged || s.MaxMinutes > 0 || s.ByTitle
	if !clientSide {
		f.Limit = s.Limit
	}

	tasks, err := st.List(ctx, f)
	if err != nil {
		return nil, err
	}
	if s.Untagged || s.MaxMinutes > 0 {
		kept := tasks[:0]
		for _, t := range tasks {
			if s.Untagged && len(t.Tags) > 0 {
				continue
			}
			if s.MaxMinutes > 0 && (t.EstimatedMinutes <= 0 || t.EstimatedMinutes >= s.MaxMinutes) {
				continue
			}
			kept = append(kept, t)
		}
		tasks = kept
	}
	if s.ByTitle {
		sort.SliceStable(tasks, func(i, j int) bool {
			a, b := strings.ToLower(tasks[i].Title), strings.ToLower(tasks[j].Title)
			if a != b {
				return a < b
			}
			return tasks[i].ID < tasks[j].ID
		})
	}
	if clientSide {
		tasks = store.Apply(tasks, s.Cond, s.Limit)
	}
	if tasks == nil {
		tasks = []*task.Task{}
	}
	return tasks, nil
}
