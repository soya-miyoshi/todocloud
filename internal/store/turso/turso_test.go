package turso

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

func TestDescribeNamesTheDatabaseAndNoCredential(t *testing.T) {
	s, err := Open(Config{URL: "libsql://tasks-acme.turso.io", Token: tokenForTest()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	got := s.Describe()
	if want := `turso database "tasks"`; got != want {
		t.Errorf("Describe() = %q, want %q", got, want)
	}
	// Describe is printed by `tdo config` and pasted into bug reports, so it
	// must not carry the token under any spelling.
	if strings.Contains(got, testToken) || strings.Contains(got, "Bearer") {
		t.Errorf("Describe() leaks the credential: %q", got)
	}
}

// A host whose name cannot be read confidently still gets a description: the
// host itself, which is public information.
func TestDescribeFallsBackToTheHost(t *testing.T) {
	s, err := Open(Config{URL: "https://localhost:8080", Token: tokenForTest()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if got, want := s.Describe(), `turso database "localhost:8080"`; got != want {
		t.Errorf("Describe() = %q, want %q", got, want)
	}
}

func TestCloseTwice(t *testing.T) {
	s, _ := openStore(t)
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// Init puts the whole schema up in one round trip after one read: a remote
// store pays a latency for every request, so the batching the pipeline exists
// for is part of the contract, not an optimisation detail.
//
// The read is the version guard. Init is idempotent and so meets stores that
// already have a schema, including one a newer tdo wrote, and writing this
// binary's version over a higher one would leave the marker describing a
// schema that is not there. That is worth a round trip on the one command a
// store sees once in its life.
func TestInitIsOneRoundTripAndIsIdempotent(t *testing.T) {
	s, f := openStore(t)
	if n := len(f.seen()); n != 2 {
		t.Errorf("Init made %d request(s), want 2 (the version guard, then the whole schema)", n)
	}
	if err := s.Add(t.Context(), newTask(idA, "keep me", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Init(t.Context()); err != nil {
		t.Fatalf("second Init: %v", err)
	}
	if _, err := s.Get(t.Context(), idA); err != nil {
		t.Fatalf("task lost by the second Init: %v", err)
	}
	v, err := s.SchemaVersion(t.Context())
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("SchemaVersion() = %d, want %d", v, SchemaVersion)
	}
}

func TestSchemaVersionBeforeInitIsNotInitialized(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// The remote engine answers "no such table: meta". The user must never
	// see that: it is a configuration problem with a known remedy.
	_, err = s.SchemaVersion(t.Context())
	if !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("SchemaVersion() error = %v, want ErrNotInitialized", err)
	}
	assertNoDriverLeak(t, err)
	if err := s.Ping(t.Context()); !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("Ping() error = %v, want ErrNotInitialized", err)
	}
	if code, _ := exit.Classify(err); code != exit.Config {
		t.Errorf("an uninitialized store exits %d, want %d", code, exit.Config)
	}
}

func TestMigrateFromAFreshDatabase(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if err := s.Migrate(t.Context()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	v, err := s.SchemaVersion(t.Context())
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("SchemaVersion() = %d, want %d", v, SchemaVersion)
	}
	// Already current: a second run changes nothing and asks for no upgrade.
	if err := s.Migrate(t.Context()); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	if err := s.Add(t.Context(), newTask(idA, "usable after migrate", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
}

// A store written by a newer binary is refused rather than guessed at, and
// the refusal is a configuration problem so the process exits 3.
func TestMigrateRefusesAFutureVersion(t *testing.T) {
	s, f := openStore(t)
	if _, err := f.db.Exec(`UPDATE meta SET value = ? WHERE key = ?`, SchemaVersion+1, metaSchemaVersion); err != nil {
		t.Fatalf("set a future version: %v", err)
	}
	err := s.Migrate(t.Context())
	if err == nil {
		t.Fatal("Migrate() succeeded against a newer schema, want an error")
	}
	if code, _ := exit.Classify(err); code != exit.Config {
		t.Errorf("a future schema exits %d, want %d", code, exit.Config)
	}
}

func TestAddGetRoundTrip(t *testing.T) {
	completed := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		fields task.Fields
	}{
		{name: "no fields", fields: task.Fields{}},
		{
			name: "the fields the CLI knows a meaning for",
			fields: task.Fields{
				task.KeyPriority: 2,
				"context":        "errands",
			},
		},
		{
			name: "unknown fields this binary knows nothing about",
			fields: task.Fields{
				"estimate": 1.5,
				"blocked":  true,
				"empty":    "",
				"nested": map[string]any{
					"owner": "sam",
					"depth": 3,
					"inner": map[string]any{"ratio": 0.25},
				},
				"mixed": []any{1, "two", true, 3.5, map[string]any{"k": "v"}},
			},
		},
		{
			// The protocol sends integers as decimal strings precisely so
			// that this value survives; a decoder that went through float64
			// would hand back 9223372036854775808.
			name: "integers across the whole int64 range",
			fields: task.Fields{
				"max":    math.MaxInt64,
				"min":    math.MinInt64,
				"zero":   0,
				"nested": map[string]any{"deep": []any{math.MaxInt64, -1}},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openStore(t)

			want := newTask(idA, "round trip", tc.fields)
			want.SetStatus(task.StatusDone, completed)
			want.UpdatedAt = want.CreatedAt
			if err := want.Validate(); err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if err := s.Add(t.Context(), want); err != nil {
				t.Fatalf("Add: %v", err)
			}

			got, err := s.Get(t.Context(), idA)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if got.Title != want.Title || got.Status != want.Status {
				t.Errorf("got %+v, want title %q status %q", got, want.Title, want.Status)
			}
			if !got.CreatedAt.Equal(want.CreatedAt) || !got.UpdatedAt.Equal(want.UpdatedAt) {
				t.Errorf("timestamps = %v / %v, want %v / %v",
					got.CreatedAt, got.UpdatedAt, want.CreatedAt, want.UpdatedAt)
			}
			if got.CompletedAt == nil || !got.CompletedAt.Equal(completed) {
				t.Errorf("CompletedAt = %v, want %v", got.CompletedAt, completed)
			}
			if got.DeletedAt != nil {
				t.Errorf("DeletedAt = %v, want nil", got.DeletedAt)
			}
			if got.Fields == nil {
				t.Fatal("Fields is nil, want an empty map at least")
			}
			if !reflect.DeepEqual(got.Fields, want.Fields) {
				t.Errorf("Fields round trip lost data:\n got %#v\nwant %#v", got.Fields, want.Fields)
			}
		})
	}
}

func TestAddRejectsADuplicateID(t *testing.T) {
	s, _ := openStore(t)
	if err := s.Add(t.Context(), newTask(idA, "first", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	err := s.Add(t.Context(), newTask(idA, "second", nil))
	if !errors.Is(err, store.ErrExists) {
		t.Fatalf("Add() of a duplicate = %v, want store.ErrExists", err)
	}
	assertNoDriverLeak(t, err)
}

func TestGetReturnsATombstonedTaskAndNotFound(t *testing.T) {
	s, _ := openStore(t)
	deleted := time.Date(2026, 6, 7, 8, 9, 10, 0, time.UTC)

	tombstoned := newTask(idA, "removed", nil)
	tombstoned.DeletedAt = &deleted
	if err := s.Add(t.Context(), tombstoned); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, err := s.Get(t.Context(), idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Deleted() || !got.DeletedAt.Equal(deleted) {
		t.Errorf("DeletedAt = %v, want %v", got.DeletedAt, deleted)
	}
	if _, err := s.Get(t.Context(), idC); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestFindByPrefix(t *testing.T) {
	tests := []struct {
		name    string
		ids     []string
		prefix  string
		wantID  string
		wantErr error
	}{
		{name: "unique hit", ids: []string{idA, idC}, prefix: "01J3A", wantID: idA},
		{name: "full id", ids: []string{idA}, prefix: idA, wantID: idA},
		{name: "lower case prefix", ids: []string{idA}, prefix: "01j3a", wantID: idA},
		{name: "no hit", ids: []string{idA}, prefix: "01J3Z", wantErr: store.ErrNotFound},
		{name: "ambiguous", ids: []string{idB, idB2}, prefix: "01J3B", wantErr: store.ErrAmbiguous},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := openStore(t)
			for _, taskID := range tc.ids {
				if err := s.Add(t.Context(), newTask(taskID, "t", nil)); err != nil {
					t.Fatalf("Add: %v", err)
				}
			}
			got, err := s.FindByPrefix(t.Context(), tc.prefix)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("FindByPrefix() error = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("FindByPrefix: %v", err)
			}
			if got.ID != tc.wantID {
				t.Errorf("FindByPrefix() id = %s, want %s", got.ID, tc.wantID)
			}
		})
	}
}

func TestList(t *testing.T) {
	seed := func(t *testing.T) *Store {
		t.Helper()
		s, _ := openStore(t)
		base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

		// Literal ids, in ascending order, so that creation order is
		// deterministic even for tasks added in the same millisecond.
		order := []string{idA, idB, idC}
		for i, name := range []string{"active", "completed", "deleted"} {
			tk := newTask(order[i], name, nil)
			switch name {
			case "completed":
				tk.SetStatus(task.StatusDone, base)
			case "deleted":
				at := base
				tk.DeletedAt = &at
			}
			// Reverse the update order relative to creation order, so that
			// OrderUpdated and OrderCreated cannot agree by accident.
			tk.UpdatedAt = base.Add(time.Duration(3-i) * time.Hour)
			if err := s.Add(t.Context(), tk); err != nil {
				t.Fatalf("Add: %v", err)
			}
		}
		return s
	}

	titles := func(tasks []*task.Task) []string {
		out := make([]string, 0, len(tasks))
		for _, t := range tasks {
			out = append(out, t.Title)
		}
		return out
	}

	tests := []struct {
		name   string
		filter store.Filter
		want   []string
	}{
		{
			name:   "a status filter keeps only that status",
			filter: store.Filter{Statuses: []task.Status{task.StatusActive}},
			want:   []string{"active"},
		},
		{
			name:   "completed only",
			filter: store.Filter{Statuses: []task.Status{task.StatusDone}},
			want:   []string{"completed"},
		},
		{
			name:   "no status filter, tombstone still excluded",
			filter: store.Filter{},
			want:   []string{"active", "completed"},
		},
		{
			name:   "tombstone included",
			filter: store.Filter{IncludeDeleted: true},
			want:   []string{"active", "completed", "deleted"},
		},
		{
			name:   "only the tombstones",
			filter: store.Filter{OnlyDeleted: true},
			want:   []string{"deleted"},
		},
		{
			name:   "limit",
			filter: store.Filter{IncludeDeleted: true, Limit: 2},
			want:   []string{"active", "completed"},
		},
		{
			name:   "order by update time",
			filter: store.Filter{IncludeDeleted: true, Order: store.OrderUpdated},
			want:   []string{"deleted", "completed", "active"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := seed(t)
			got, err := s.List(t.Context(), tc.filter)
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if !reflect.DeepEqual(titles(got), tc.want) {
				t.Errorf("List() = %v, want %v", titles(got), tc.want)
			}
			for _, tk := range got {
				if tk.Fields == nil {
					t.Errorf("task %s has nil Fields", tk.ID)
				}
				if tk.Tags == nil {
					t.Errorf("task %s has nil Tags", tk.ID)
				}
			}
		})
	}
}

// A remote store pays a latency for every request, so the number of round
// trips a command costs is part of the contract rather than an optimisation
// detail. A listing reads its candidates, their tags and the tree it needs
// for availability and tree order in one pipeline.
func TestAListingIsOneRoundTrip(t *testing.T) {
	s, f := openStore(t)
	if err := s.Add(t.Context(), newTask(idA, "a task", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	before := len(f.seen())
	if _, err := s.List(t.Context(), store.Filter{Availability: store.AvailabilityAvailable}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if n := len(f.seen()) - before; n != 1 {
		t.Errorf("List made %d request(s), want 1", n)
	}
}

// A write is two: one that reads the tree the placement rules are decided
// against, and one that carries every statement of the change. There is no
// transaction over the wire, so the decision has to be made before anything
// is sent — but it must not cost more than one request either.
func TestAWriteIsTwoRoundTrips(t *testing.T) {
	s, f := openStore(t)
	stored := newTask(idA, "a task", nil)
	stored.SetTags([]string{"home", "errand"})

	before := len(f.seen())
	if err := s.Add(t.Context(), stored); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if n := len(f.seen()) - before; n != 2 {
		t.Errorf("Add made %d request(s), want 2", n)
	}

	stored.Title = "edited"
	before = len(f.seen())
	if err := s.Update(t.Context(), stored); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if n := len(f.seen()) - before; n != 2 {
		t.Errorf("Update made %d request(s), want 2", n)
	}

	got, err := s.Get(t.Context(), idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(got.Tags, []string{"errand", "home"}) {
		t.Errorf("tags = %v, want [errand home]", got.Tags)
	}
}

func TestListCreationOrderUsesGeneratedIDs(t *testing.T) {
	s, _ := openStore(t)

	var want []string
	for i := 0; i < 5; i++ {
		taskID := id.New()
		want = append(want, taskID)
		if err := s.Add(t.Context(), newTask(taskID, "t", nil)); err != nil {
			t.Fatalf("Add: %v", err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	got, err := s.List(t.Context(), store.Filter{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("List() returned %d tasks, want %d", len(got), len(want))
	}
	for i, tk := range got {
		if tk.ID != want[i] {
			t.Fatalf("task %d = %s, want %s (creation order)", i, tk.ID, want[i])
		}
	}
}

func TestUpdate(t *testing.T) {
	s, _ := openStore(t)

	original := newTask(idA, "write the provider", task.Fields{task.KeyPriority: 1})
	if err := s.Add(t.Context(), original); err != nil {
		t.Fatalf("Add: %v", err)
	}

	edited := original.Clone()
	edited.Title = "write the provider tests"
	edited.UpdatedAt = original.UpdatedAt.Add(time.Hour)
	edited.SetStatus(task.StatusDone, edited.UpdatedAt)
	edited.Fields.Set(task.KeyPriority, 3)
	edited.Fields.Set("owner", "sam")
	if err := s.Update(t.Context(), edited); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := s.Get(t.Context(), idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != edited.Title || got.Status != task.StatusDone {
		t.Errorf("got %q status=%q, want %q done", got.Title, got.Status, edited.Title)
	}
	if !reflect.DeepEqual(got.Fields, edited.Fields) {
		t.Errorf("Fields = %#v, want %#v", got.Fields, edited.Fields)
	}

	if err := s.Update(t.Context(), newTask(idC, "never stored", nil)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Update(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestPurge(t *testing.T) {
	s, _ := openStore(t)
	if err := s.Add(t.Context(), newTask(idA, "temporary", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Purge(t.Context(), idA); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if _, err := s.Get(t.Context(), idA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get after Purge error = %v, want ErrNotFound", err)
	}
	if err := s.Purge(t.Context(), idA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Purge(unknown) error = %v, want ErrNotFound", err)
	}
}

// Only `tdo init` may create a store. OpenExisting against a database that
// holds no schema must fail, and must leave nothing behind: a read-only
// command that quietly created a second, empty task list would look exactly
// like the real one.
func TestOpenExistingWithoutASchemaCreatesNothing(t *testing.T) {
	f := newFakeServer(t)

	s, err := OpenExisting(f.config())
	if err == nil {
		s.Close()
		t.Fatal("OpenExisting() succeeded against a database with no schema")
	}
	if !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("OpenExisting() error = %v, want ErrNotInitialized", err)
	}
	assertNoDriverLeak(t, err)

	// Nothing was created: the engine still has no tables, and every
	// statement that reached it was a read.
	var tables int
	if err := f.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table'`).Scan(&tables); err != nil {
		t.Fatalf("count tables: %v", err)
	}
	if tables != 0 {
		t.Errorf("OpenExisting created %d table(s); it must create nothing", tables)
	}
	for _, req := range f.seen() {
		if strings.Contains(strings.ToUpper(req.Body), "CREATE ") {
			t.Errorf("OpenExisting sent a CREATE statement: %s", req.Body)
		}
	}
}

func TestOpenExistingOnAnInitializedDatabase(t *testing.T) {
	_, f := openStore(t)

	s, err := OpenExisting(f.config())
	if err != nil {
		t.Fatalf("OpenExisting: %v", err)
	}
	defer s.Close()
	if err := s.Add(t.Context(), newTask(idA, "usable", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
}

// Every task method reports an uninitialized database as such, rather than
// passing the engine's "no such table: tasks" on to the user.
func TestEveryMethodReportsAnUninitializedDatabase(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	ops := []struct {
		name string
		run  func() error
	}{
		{"Get", func() error { _, err := s.Get(t.Context(), idA); return err }},
		{"FindByPrefix", func() error { _, err := s.FindByPrefix(t.Context(), "01J3"); return err }},
		{"List", func() error { _, err := s.List(t.Context(), store.Filter{}); return err }},
		{"Update", func() error { return s.Update(t.Context(), newTask(idA, "nope", nil)) }},
		{"Purge", func() error { return s.Purge(t.Context(), idA) }},
		{"PurgeSubtree", func() error { _, err := s.PurgeSubtree(t.Context(), idA); return err }},
		{"Add", func() error { return s.Add(t.Context(), newTask(idA, "nope", nil)) }},
		{"Move", func() error { return s.Move(t.Context(), idA, "", 0, testNow) }},
		{"Children", func() error { _, err := s.Children(t.Context(), ""); return err }},
		{"Subtree", func() error { _, err := s.Subtree(t.Context(), idA); return err }},
		{"Availability", func() error { _, err := s.Availability(t.Context(), testNow, idA); return err }},
		{"Tags", func() error { _, err := s.Tags(t.Context()); return err }},
		{"Perspectives", func() error { _, err := s.Perspectives(t.Context()); return err }},
		{"Perspective", func() error { _, err := s.Perspective(t.Context(), "next"); return err }},
		{"SavePerspective", func() error {
			return s.SavePerspective(t.Context(), &store.Perspective{Name: "next", UpdatedAt: testNow})
		}},
		{"DeletePerspective", func() error { return s.DeletePerspective(t.Context(), "next") }},
	}
	for _, op := range ops {
		err := op.run()
		if !errors.Is(err, store.ErrNotInitialized) {
			t.Errorf("%s() error = %v, want ErrNotInitialized", op.name, err)
		}
		assertNoDriverLeak(t, err)
	}
}

// A method called after Close reports it instead of panicking.
func TestMethodsAfterCloseReportTheClosedStore(t *testing.T) {
	s, _ := openStore(t)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := s.Get(t.Context(), idA); !errors.Is(err, errClosed) {
		t.Errorf("Get() after Close = %v, want errClosed", err)
	}
	if err := s.Init(t.Context()); !errors.Is(err, errClosed) {
		t.Errorf("Init() after Close = %v, want errClosed", err)
	}
}
