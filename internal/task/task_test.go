package task

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := ParseTime(s)
	if err != nil {
		t.Fatalf("ParseTime(%q): %v", s, err)
	}
	return v
}

func sample(t *testing.T) *Task {
	t.Helper()
	at := mustTime(t, "2026-10-20T04:11:00Z")
	task := New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", KindTask, "Pay the invoice", at)
	task.Fields = Fields{KeyPriority: 2, "client": "acme"}
	task.SetTags([]string{"finance"})
	return task
}

func TestTheJSONShapeIsTheDocumentedOne(t *testing.T) {
	task := sample(t)
	task.DueAt = ptrTime(mustTime(t, "2026-11-01T00:00:00Z"))
	data, err := json.Marshal(task)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	want := map[string]any{
		"id":                    "01J3ZQK8V9XW5S6R7T8Y9Z0A1B",
		"kind":                  "task",
		"title":                 "Pay the invoice",
		"parent_id":             nil,
		"position":              float64(0),
		"status":                "active",
		"flagged":               false,
		"sequential":            false,
		"completed_by_children": false,
		"defer_at":              nil,
		"due_at":                "2026-11-01T00:00:00Z",
		"estimated_minutes":     float64(0),
		"note":                  nil,
		"repeat":                nil,
		"series_id":             nil,
		"review_interval":       nil,
		"last_reviewed_at":      nil,
		"created_at":            "2026-10-20T04:11:00Z",
		"updated_at":            "2026-10-20T04:11:00Z",
		"completed_at":          nil,
		"dropped_at":            nil,
		"deleted_at":            nil,
		"tags":                  []any{"finance"},
		"done":                  false,
		"priority":              float64(2),
		"client":                "acme",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("JSON shape mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

// done is derived from the status, so that the common question stays one key
// for a caller that does not care about the other three states.
func TestDoneIsDerivedFromTheStatus(t *testing.T) {
	task := sample(t)
	for status, want := range map[Status]bool{
		StatusActive:  false,
		StatusOnHold:  false,
		StatusDropped: false,
		StatusDone:    true,
	} {
		task.Status = status
		data, err := json.Marshal(task)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		var got map[string]any
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("Unmarshal: %v", err)
		}
		if got["done"] != want {
			t.Errorf("status %q must render done as %v, got %v", status, want, got["done"])
		}
	}
}

// Losslessness is what `tdo export | tdo import` rests on: a field this binary
// has never heard of must come back identical in meaning.
func TestARoundTripPreservesFieldsThisBinaryDoesNotKnow(t *testing.T) {
	at := mustTime(t, "2026-10-20T04:11:00Z")
	done := mustTime(t, "2026-10-21T09:00:00Z")
	original := New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", KindTask, "Ship v0.1", at)
	original.Status = StatusDone
	original.UpdatedAt = done
	original.CompletedAt = &done
	original.ParentID = "01J3ZQK8V9XW5S6R7T8Y9Z0A1C"
	original.Position = 7
	original.Flagged = true
	original.Sequential = true
	original.CompletedByChildren = true
	original.DeferAt = &at
	original.DueAt = &done
	original.EstimatedMinutes = 45
	original.Note = "two lines\nof note"
	original.Repeat = &Repeat{Method: RepeatFromCompletion, Every: "1mo:last-friday"}
	original.SeriesID = "01J3ZQK8V9XW5S6R7T8Y9Z0A1D"
	original.ReviewInterval = nil
	original.SetTags([]string{"release", "go"})
	original.Fields = Fields{
		KeyPriority: 3,
		"client":    "acme",
		"estimate":  5,
		"ratio":     0.25,
		"blocked":   false,
		"links":     []any{"https://example.com", 7},
		"meta":      map[string]any{"owner": "me", "rounds": 2},
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back Task
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if !reflect.DeepEqual(back.Fields, original.Fields) {
		t.Errorf("user-defined fields changed across a round trip\n got: %#v\nwant: %#v", back.Fields, original.Fields)
	}
	if !reflect.DeepEqual(back.Tags, original.Tags) {
		t.Errorf("tags changed across a round trip: got %v, want %v", back.Tags, original.Tags)
	}
	if !back.Repeat.Equal(original.Repeat) {
		t.Errorf("repeat changed across a round trip: got %+v", back.Repeat)
	}
	for _, c := range []struct {
		name      string
		got, want any
	}{
		{"id", back.ID, original.ID},
		{"kind", back.Kind, original.Kind},
		{"status", back.Status, original.Status},
		{"parent_id", back.ParentID, original.ParentID},
		{"position", back.Position, original.Position},
		{"flagged", back.Flagged, original.Flagged},
		{"sequential", back.Sequential, original.Sequential},
		{"completed_by_children", back.CompletedByChildren, original.CompletedByChildren},
		{"estimated_minutes", back.EstimatedMinutes, original.EstimatedMinutes},
		{"note", back.Note, original.Note},
		{"series_id", back.SeriesID, original.SeriesID},
	} {
		if c.got != c.want {
			t.Errorf("%s changed across a round trip: got %v, want %v", c.name, c.got, c.want)
		}
	}
	if back.CompletedAt == nil || !back.CompletedAt.Equal(done) {
		t.Errorf("completed_at = %v, want %v", back.CompletedAt, done)
	}
}

// A document a human wrote by hand, or one from before a key existed, must
// land on a usable task rather than on an invalid one.
func TestADocumentMissingKindOrStatusLandsOnTheDefaults(t *testing.T) {
	var back Task
	raw := `{"id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1B","title":"x","created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}`
	if err := json.Unmarshal([]byte(raw), &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Kind != KindTask || back.Status != StatusActive {
		t.Errorf("a document with no kind or status must read as an active task, got kind %q status %q", back.Kind, back.Status)
	}
	if err := back.Validate(); err != nil {
		t.Errorf("the result must be valid, but Validate said %v", err)
	}
}

func TestADerivedKeyIsNotReadBackAsAUserField(t *testing.T) {
	var back Task
	raw := `{"id":"01J3","title":"x","status":"active","done":true,"available":false,"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}`
	if err := json.Unmarshal([]byte(raw), &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(back.Fields) != 0 {
		t.Errorf("a derived key must be discarded on the way in, not stored as a user-defined field: %#v", back.Fields)
	}
	if back.Status != StatusActive {
		t.Errorf("the status column decides, not the derived done: got %q", back.Status)
	}
}

func TestValidateRejectsWhatNoProviderCouldStore(t *testing.T) {
	at := mustTime(t, "2026-10-20T04:11:00Z")
	tests := []struct {
		name    string
		mutate  func(*Task)
		wantErr bool
	}{
		{"valid", func(*Task) {}, false},
		{"empty title", func(t *Task) { t.Title = "" }, true},
		{"blank title", func(t *Task) { t.Title = "   " }, true},
		{"missing id", func(t *Task) { t.ID = "" }, true},
		{"unknown kind", func(t *Task) { t.Kind = "wish" }, true},
		{"unknown status", func(t *Task) { t.Status = "maybe" }, true},
		{"a folder is never completed", func(t *Task) { t.Kind, t.Status = KindFolder, StatusDone }, true},
		{"its own parent", func(t *Task) { t.ParentID = t.ID }, true},
		{"missing timestamps", func(t *Task) { t.CreatedAt, t.UpdatedAt = time.Time{}, time.Time{} }, true},
		{"negative estimate", func(t *Task) { t.EstimatedMinutes = -1 }, true},
		{"reserved field name", func(t *Task) { t.Fields[KeyStatus] = "active" }, true},
		{"derived field name is reserved too", func(t *Task) { t.Fields[KeyDone] = true }, true},
		{"empty field name", func(t *Task) { t.Fields[""] = 1 }, true},
		{"priority too high", func(t *Task) { t.Fields[KeyPriority] = 4 }, true},
		{"priority at the top of the range", func(t *Task) { t.Fields[KeyPriority] = 3 }, false},
		{"a repeat with no interval", func(t *Task) { t.Repeat = &Repeat{Method: RepeatFixed} }, true},
		{"a repeat with an unknown method", func(t *Task) { t.Repeat = &Repeat{Method: "sometimes", Every: "1w"} }, true},
		{"a valid repeat", func(t *Task) { t.Repeat = &Repeat{Method: RepeatFixed, Every: "1w"} }, false},
		{"a review interval on a task", func(t *Task) { t.ReviewInterval = &ReviewInterval{Every: "1w"} }, true},
		{"a review interval on a project", func(t *Task) {
			t.Kind = KindProject
			t.ReviewInterval = &ReviewInterval{Every: "1w"}
		}, false},
		{"an empty tag", func(t *Task) { t.Tags = []string{" "} }, true},
		{"unknown field is allowed", func(t *Task) { t.Fields["whatever"] = []any{1, "two"} }, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task := New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", KindTask, "x", at)
			tc.mutate(task)
			err := task.Validate()
			if (err != nil) != tc.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestSetStatusKeepsTheTimestampsHonest(t *testing.T) {
	at := mustTime(t, "2026-10-20T04:11:00Z")
	now := mustTime(t, "2026-10-21T09:00:00Z")
	task := New("01J3ZQK8V9XW5S6R7T8Y9Z0A1B", KindTask, "x", at)

	task.SetStatus(StatusDone, now)
	if !task.Done() || task.CompletedAt == nil || !task.CompletedAt.Equal(now) || !task.UpdatedAt.Equal(now) {
		t.Fatalf("after SetStatus(done): %#v", task)
	}

	// A no-op must not move updated_at, so a repeated `tdo done` is harmless.
	later := now.Add(time.Hour)
	task.SetStatus(StatusDone, later)
	if !task.UpdatedAt.Equal(now) {
		t.Errorf("updated_at = %v, want it unchanged at %v", task.UpdatedAt, now)
	}

	task.SetStatus(StatusDropped, later)
	if task.CompletedAt != nil || task.DroppedAt == nil || !task.DroppedAt.Equal(later) {
		t.Errorf("dropping a completed task must move the timestamp with it: %#v", task)
	}

	task.SetStatus(StatusActive, later.Add(time.Hour))
	if task.CompletedAt != nil || task.DroppedAt != nil {
		t.Errorf("reopening a task must clear both timestamps: %#v", task)
	}
}

func TestTagsAreASetComparedCaseInsensitively(t *testing.T) {
	task := sample(t)
	task.SetTags([]string{"Home", "home", " errand ", "", "Errand"})
	if !reflect.DeepEqual(task.Tags, []string{"errand", "Home"}) {
		t.Errorf("tags must be trimmed, deduplicated case-insensitively in the spelling first typed, and sorted: got %v", task.Tags)
	}
	if !task.HasTag("HOME") || task.HasTag("work") {
		t.Error("HasTag must compare case-insensitively")
	}
}

func TestTheContainmentTableIsWhatPlanSaysItIs(t *testing.T) {
	want := map[Kind][]Kind{
		KindFolder:  {KindFolder, KindProject},
		KindProject: {KindTask},
		KindTask:    {KindTask},
	}
	for parent, allowed := range want {
		for _, child := range Kinds() {
			ok := false
			for _, a := range allowed {
				ok = ok || a == child
			}
			if parent.CanContain(child) != ok {
				t.Errorf("a %s %s contain a %s", parent, map[bool]string{true: "must", false: "must not"}[ok], child)
			}
		}
	}
}

func TestInboxIsTheAbsenceOfAParent(t *testing.T) {
	at := mustTime(t, "2026-10-20T04:11:00Z")
	loose := New("01J3", KindTask, "loose", at)
	if !loose.Inbox() {
		t.Error("a task with no parent is in the inbox")
	}
	loose.ParentID = "01J4"
	if loose.Inbox() {
		t.Error("a task with a parent is not in the inbox")
	}
	project := New("01J5", KindProject, "a project", at)
	if project.Inbox() {
		t.Error("a top-level project is at the top level, which is not the inbox")
	}
	if New("01J6", KindFolder, "f", at).Actionable() {
		t.Error("a folder is never actionable")
	}
}

func TestCloneIsDeep(t *testing.T) {
	original := sample(t)
	original.Fields["meta"] = map[string]any{"owner": "me"}
	original.Repeat = &Repeat{Method: RepeatFixed, Every: "1w"}
	clone := original.Clone()

	clone.Title = "changed"
	clone.Fields[KeyPriority] = 1
	clone.Fields["meta"].(map[string]any)["owner"] = "someone else"
	clone.Tags[0] = "changed"
	clone.Repeat.Every = "2w"

	if original.Title == clone.Title {
		t.Error("clone shares the title")
	}
	if p := original.Fields.Priority(); p != 2 {
		t.Errorf("original priority = %d, want 2", p)
	}
	if got := original.Fields["meta"].(map[string]any)["owner"]; got != "me" {
		t.Errorf("nested map was shared: owner = %q", got)
	}
	if original.Tags[0] != "finance" {
		t.Errorf("tags were shared: %v", original.Tags)
	}
	if original.Repeat.Every != "1w" {
		t.Errorf("repeat was shared: %+v", original.Repeat)
	}
}

func TestEveryStoredAndDerivedNameIsReserved(t *testing.T) {
	for _, key := range []string{
		KeyID, KeyKind, KeyTitle, KeyParentID, KeyPosition, KeyStatus, KeyFlagged,
		KeySequential, KeyCompletedByChildren, KeyDeferAt, KeyDueAt, KeyEstimatedMinutes,
		KeyNote, KeyRepeat, KeySeriesID, KeyReviewInterval, KeyLastReviewedAt,
		KeyCreatedAt, KeyUpdatedAt, KeyCompletedAt, KeyDroppedAt, KeyDeletedAt,
		KeyTags, KeyDone, KeyAvailable, KeyBlockedBy, KeyNextReview,
	} {
		if !Reserved(key) {
			t.Errorf("Reserved(%q) = false: a user field of that name would shadow a required or derived one", key)
		}
	}
	for _, key := range []string{KeyPriority, "client", "due", "notes"} {
		if Reserved(key) {
			t.Errorf("Reserved(%q) = true, want false: it is an ordinary open field", key)
		}
	}
	if got := len(ReservedKeys()); got != 27 {
		t.Errorf("ReservedKeys() returned %d keys, want 27", got)
	}
}

func ptrTime(v time.Time) *time.Time { return &v }
