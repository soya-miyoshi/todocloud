package schema

import "testing"

// The ladder and the version are one thing in two parts, and the part that
// is easy to forget is the step. Bumping Version without appending the step
// that gets there must stop the process rather than leave a binary that
// expects a schema nothing produces.
func TestTheLadderMustReachTheVersionItClaims(t *testing.T) {
	original := steps
	t.Cleanup(func() { steps = original })

	steps = []Step{{To: 2, Name: "a step past the current version", Statements: []string{"SELECT 1"}}}
	if err := validate(); err == nil {
		t.Error("a ladder that climbs past Version must be refused, because one of the two was edited and the other was not")
	}

	steps = []Step{{To: 3, Name: "a step that skips version 2", Statements: []string{"SELECT 1"}}}
	if err := validate(); err == nil {
		t.Error("a ladder with a gap in it must be refused; a store at version 2 would have nothing to run")
	}

	steps = []Step{{To: 2, Statements: []string{"SELECT 1"}}}
	if err := validate(); err == nil {
		t.Error("a step with no name must be refused; the name is what `tdo migrate` prints and what a failure reports")
	}

	steps = original
	if err := validate(); err != nil {
		t.Errorf("the shipped ladder must be consistent with Version %d: %v", Version, err)
	}
}

// Pending is what both providers iterate, so it decides what a store owes.
func TestPendingReturnsOnlyTheStepsAStoreStillOwes(t *testing.T) {
	original := steps
	t.Cleanup(func() { steps = original })
	steps = []Step{
		{To: 2, Name: "two", Statements: []string{"SELECT 2"}},
		{To: 3, Name: "three", Statements: []string{"SELECT 3"}},
	}
	for _, tc := range []struct {
		from int
		want []int
	}{
		{1, []int{2, 3}},
		{2, []int{3}},
		{3, nil},
		{4, nil},
	} {
		got := Pending(tc.from)
		if len(got) != len(tc.want) {
			t.Fatalf("Pending(%d) returned %d step(s), want %d", tc.from, len(got), len(tc.want))
		}
		for i, step := range got {
			if step.To != tc.want[i] {
				t.Errorf("Pending(%d)[%d] climbs to %d, want %d", tc.from, i, step.To, tc.want[i])
			}
		}
	}
}

// The DDL is handed to two providers that will each loop over it. Neither
// may be able to edit the schema for the other by accident.
func TestInitialAndStepsHandOutCopies(t *testing.T) {
	first := Initial()
	if len(first) == 0 {
		t.Fatal("Initial returned no statements")
	}
	first[0] = "DROP TABLE tasks"
	if Initial()[0] == "DROP TABLE tasks" {
		t.Error("Initial handed out the package's own slice; a provider could rewrite the schema for the other one")
	}
}

// Every released version needs its frozen DDL, or the conformance harness
// has nothing to carry forward from and quietly checks less than it claims.
func TestEveryReleasedVersionHasItsHistoricalSchema(t *testing.T) {
	for v := 1; v <= Version; v++ {
		if _, ok := Historical(v); !ok {
			t.Errorf("version %d has no frozen DDL in historical.go; without it nothing proves a store created by that release can still be migrated", v)
		}
	}
	if got := HistoricalVersions(); len(got) != Version {
		t.Errorf("HistoricalVersions returned %v, want one entry per released version up to %d", got, Version)
	}
}
