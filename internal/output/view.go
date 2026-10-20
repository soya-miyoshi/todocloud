package output

import (
	"encoding/json"

	"github.com/soya-miyoshi/todocloud/internal/recur"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// NewTaskView pairs one task with the availability answer for it. asked is
// false when the caller did not compute availability, which emits null for
// `available` and `blocked_by` rather than claiming the item is blocked for
// no reason.
func NewTaskView(t *task.Task, a store.Availability, asked bool) TaskView {
	return TaskView{task: t, availability: a, asked: asked}
}

// TaskView is the JSON shape of one task everywhere tdo emits one: the stored
// task, flattened as task.Task marshals it, plus the three derived keys a
// caller must not have to recompute — `available`, `blocked_by` and
// `next_review_at` (§3.3, §3.5).
//
// Every command that emits a task emits this, so an agent parses one shape
// rather than one per command. `blocked_by` is null when the item is
// available, and an object naming the rule and the item responsible when it
// is not.
type TaskView struct {
	task         *task.Task
	availability store.Availability
	// asked records that availability was computed for this task. A command
	// that cannot know it — there is none today — would emit null rather
	// than claim the item is blocked for no reason.
	asked bool
}

// blockedBy is the documented object under the `blocked_by` key. Tag is
// present only for the two rules that name one — `tag_status` and
// `ancestor_tag_status` — so a caller switching on `rule` never has to ask
// whether the key might be there for another.
type blockedBy struct {
	Rule   string `json:"rule"`
	TaskID string `json:"task_id"`
	Tag    string `json:"tag,omitempty"`
}

func (v TaskView) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(v.task)
	if err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}

	add := func(key string, value any) error {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		out[key] = encoded
		return nil
	}

	if v.asked {
		if err := add(task.KeyAvailable, v.availability.Available); err != nil {
			return nil, err
		}
		var blocker any
		if !v.availability.Available {
			blocker = blockedBy{
				Rule:   string(v.availability.Rule),
				TaskID: v.availability.BlockedBy,
				Tag:    v.availability.Tag,
			}
		}
		if err := add(task.KeyBlockedBy, blocker); err != nil {
			return nil, err
		}
	} else {
		if err := add(task.KeyAvailable, nil); err != nil {
			return nil, err
		}
		if err := add(task.KeyBlockedBy, nil); err != nil {
			return nil, err
		}
	}

	// next_review_at is derived from last_reviewed_at and the interval, so it
	// cannot drift out of sync with either half (§3.5). It is null on
	// anything with no review interval, which is every task.
	var nextReview any
	if next, ok := recur.NextReviewAt(v.task, v.task.UpdatedAt); ok {
		nextReview = task.FormatTime(next)
	}
	if err := add(task.KeyNextReview, nextReview); err != nil {
		return nil, err
	}
	return json.Marshal(out)
}

// Views pairs tasks with the availability answer for each of them.
func Views(tasks []*task.Task, av map[string]store.Availability) []TaskView {
	out := make([]TaskView, 0, len(tasks))
	for _, t := range tasks {
		a, ok := av[t.ID]
		out = append(out, TaskView{task: t, availability: a, asked: ok})
	}
	return out
}
