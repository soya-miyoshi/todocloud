package store

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

var now = time.Date(2026, 10, 20, 4, 11, 0, 0, time.UTC)

func newTask(fields task.Fields) *task.Task {
	if fields == nil {
		fields = task.Fields{}
	}
	t := task.New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", task.KindTask, "Pay the invoice", now)
	t.Fields = fields
	return t
}

func TestTheZeroConditionFiltersNothing(t *testing.T) {
	if !(Condition{}).Empty() {
		t.Error("the zero Condition reported itself as filtering")
	}
	for name, c := range map[string]Condition{
		"priority": {MinPriority: 1},
		"match":    {Match: map[string]string{"k": "v"}},
	} {
		if c.Empty() {
			t.Errorf("Condition with %s reported itself as empty", name)
		}
	}
	if !(Condition{}).Matches(newTask(nil)) {
		t.Error("the zero Condition rejected a task")
	}
}

func TestAConditionReadsTheUserDefinedFields(t *testing.T) {
	tests := []struct {
		name  string
		cond  Condition
		task  *task.Task
		match bool
	}{
		{
			"priority at the floor matches",
			Condition{MinPriority: 2},
			newTask(task.Fields{task.KeyPriority: 2}),
			true,
		},
		{
			"priority below the floor does not",
			Condition{MinPriority: 3},
			newTask(task.Fields{task.KeyPriority: 2}),
			false,
		},
		{
			"an unset priority is zero and fails any floor",
			Condition{MinPriority: 1},
			newTask(nil),
			false,
		},
		{
			"a string field matches as written",
			Condition{Match: map[string]string{"owner": "sam"}},
			newTask(task.Fields{"owner": "sam"}),
			true,
		},
		{
			"a numeric field matches a number, not its spelling",
			Condition{Match: map[string]string{"estimate": "3"}},
			newTask(task.Fields{"estimate": 3}),
			true,
		},
		{
			"a boolean field matches a boolean",
			Condition{Match: map[string]string{"blocked": "true"}},
			newTask(task.Fields{"blocked": true}),
			true,
		},
		{
			"a required field is matchable by name too",
			Condition{Match: map[string]string{task.KeyStatus: "active"}},
			newTask(nil),
			true,
		},
		{
			"a field that is not there matches nothing",
			Condition{Match: map[string]string{"missing": "x"}},
			newTask(nil),
			false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cond.Matches(tc.task); got != tc.match {
				t.Errorf("Matches() = %v, want %v", got, tc.match)
			}
		})
	}
}

func TestApplyStopsAtTheLimit(t *testing.T) {
	tasks := []*task.Task{newTask(nil), newTask(nil), newTask(nil)}
	if got := Apply(tasks, Condition{}, 2); len(got) != 2 {
		t.Errorf("Apply() returned %d tasks, want 2", len(got))
	}
	if got := Apply(tasks, Condition{}, 0); len(got) != 3 {
		t.Errorf("a limit of zero means no limit, but Apply() returned %d tasks", len(got))
	}
	if got := Apply(tasks, Condition{MinPriority: 1}, 0); len(got) != 0 {
		t.Errorf("Apply() kept %d tasks a condition rejects", len(got))
	}
}

// The availability truth table is exercised end to end by the conformance
// suite; what is checked here is the shape the --json caller sees and the
// cases the tree answers without a store at all.
func TestAvailabilityMarshalsAsTrueOrAReason(t *testing.T) {
	b, err := json.Marshal(Availability{Available: true})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if string(b) != "true" {
		t.Errorf("an available item must marshal as a bare true, got %s", b)
	}

	b, err = json.Marshal(Availability{Rule: RuleAncestorStatus, BlockedBy: "01J3"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got["rule"] != "ancestor_status" || got["task_id"] != "01J3" || got["available"] != false {
		t.Errorf("blocked_by must name the rule and the item responsible, got %s", b)
	}
}

func TestATreeWithABrokenEdgeDoesNotLoopOrLie(t *testing.T) {
	// A parent that is not in the tree: a database edited by hand, or a
	// half-finished sync. The item must not be reported as available.
	orphan := task.New("01J3ORPHAN0000000000000000", task.KindTask, "orphan", now)
	orphan.ParentID = "01J3MISSING000000000000000"
	tr := NewTree([]*task.Task{orphan})
	a := tr.Availability(orphan.ID, now)
	if a.Available || a.Rule != RuleMissingParent {
		t.Errorf("an item whose parent is missing must be blocked by %q, got %+v", RuleMissingParent, a)
	}

	// Two items that are each other's parent. Nothing in this package can
	// create that, but the walk must terminate if it is ever read.
	a1 := task.New("01J3A00000000000000000000A", task.KindTask, "a", now)
	b1 := task.New("01J3A00000000000000000000B", task.KindTask, "b", now)
	a1.ParentID, b1.ParentID = b1.ID, a1.ID
	tr = NewTree([]*task.Task{a1, b1})
	if got := tr.Ancestors(a1.ID); len(got) > 2 {
		t.Errorf("Ancestors must stop rather than loop on a cycle, it returned %d items", len(got))
	}
	tr.Availability(a1.ID, now)
	tr.Subtree(a1.ID)
}

func TestAnUnknownIDIsAbsentFromAnAvailabilityAnswer(t *testing.T) {
	tr := NewTree(nil)
	if got := tr.AvailabilityOf(now, "01J3NOTHING000000000000000"); len(got) != 0 {
		t.Errorf("an unknown id must be absent from the result rather than invented, got %v", got)
	}
}

func TestAFilterRefusesValuesAProviderCouldNotHonour(t *testing.T) {
	for name, f := range map[string]Filter{
		"kind":         {Kinds: []task.Kind{"wish"}},
		"status":       {Statuses: []task.Status{"maybe"}},
		"availability": {Availability: "someday"},
		"order":        {Order: "alphabetical"},
		"limit":        {Limit: -1},
	} {
		if err := f.Validate(); err == nil {
			t.Errorf("a filter with an invalid %s must be refused, so that a bad perspective fails where it is read", name)
		}
	}
	if err := (Filter{}).Validate(); err != nil {
		t.Errorf("the zero filter is valid and matches everything live, but Validate said %v", err)
	}
}

func TestAFilterRoundTripsThroughJSONSoAPerspectiveCanHoldIt(t *testing.T) {
	flagged := true
	cut := now
	want := Filter{
		Kinds:        []task.Kind{task.KindTask},
		Statuses:     []task.Status{task.StatusActive, task.StatusOnHold},
		Availability: AvailabilityAvailable,
		Flagged:      &flagged,
		Scope:        Scope{Subtree: "01J3"},
		Tags:         []string{"home"},
		DueBefore:    &cut,
		Order:        OrderDue,
		Limit:        5,
	}
	b, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Filter
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Order != want.Order || got.Availability != want.Availability ||
		got.Scope.Subtree != want.Scope.Subtree || got.Limit != want.Limit ||
		got.Flagged == nil || *got.Flagged != flagged ||
		got.DueBefore == nil || !got.DueBefore.Equal(cut) {
		t.Errorf("a perspective is a stored filter, so a filter must read back as itself\n got  %+v\n want %+v", got, want)
	}
}
