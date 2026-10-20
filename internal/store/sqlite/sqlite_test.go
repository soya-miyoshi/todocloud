package sqlite

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Literal ids for the tests that need a deterministic order or a shared
// prefix. They are 26-character Crockford base32, upper case, no I/L/O/U.
const (
	idA  = "01J3ABCDEFGHJKMNPQRSTVWXYZ"
	idB  = "01J3BBCDEFGHJKMNPQRSTVWXYZ"
	idC  = "01J3CBCDEFGHJKMNPQRSTVWXYZ"
	idB2 = "01J3BBCDEFGHJKMNPQRSTVWXY0"
)

// openStore returns an initialized in-memory store.
func openStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(MemoryPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return s
}

// newTask builds a valid task with the given id and fields.
func newTask(taskID, title string, fields task.Fields) *task.Task {
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	if fields == nil {
		fields = task.Fields{}
	}
	return &task.Task{
		ID:        taskID,
		Kind:      task.KindTask,
		Title:     title,
		Status:    task.StatusActive,
		CreatedAt: now,
		UpdatedAt: now,
		Fields:    fields,
	}
}

func TestOpenMemory(t *testing.T) {
	s, err := Open(MemoryPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if err := s.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := s.Ping(context.Background()); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if got, want := s.Describe(), "sqlite: "+MemoryPath; got != want {
		t.Errorf("Describe() = %q, want %q", got, want)
	}
}

func TestOpenCreatesParentDirectories(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "deeper", "tasks.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if err := s.Init(context.Background()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("database file not created: %v", err)
	}
}

func TestCloseTwice(t *testing.T) {
	s := openStore(t)
	if err := s.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestInitIsIdempotent(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Add(ctx, newTask(idA, "keep me", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Init(ctx); err != nil {
		t.Fatalf("second Init: %v", err)
	}
	if _, err := s.Get(ctx, idA); err != nil {
		t.Fatalf("task lost by second Init: %v", err)
	}
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("SchemaVersion() = %d, want %d", v, SchemaVersion)
	}
}

func TestSchemaVersionBeforeInit(t *testing.T) {
	s, err := Open(MemoryPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if _, err := s.SchemaVersion(context.Background()); !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("SchemaVersion() error = %v, want ErrNotInitialized", err)
	}
	if err := s.Ping(context.Background()); !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("Ping() error = %v, want ErrNotInitialized", err)
	}
}

func TestMigrateFromFreshStore(t *testing.T) {
	s, err := Open(MemoryPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	ctx := context.Background()

	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		t.Fatalf("SchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("SchemaVersion() = %d, want %d", v, SchemaVersion)
	}
	// Already current: a second run changes nothing.
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	if err := s.Add(ctx, newTask(idA, "usable after migrate", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
}

func TestMigrateRefusesFutureVersion(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	_, err := s.db.ExecContext(ctx, `UPDATE meta SET value = ? WHERE key = ?`,
		SchemaVersion+1, metaSchemaVersion)
	if err != nil {
		t.Fatalf("set future version: %v", err)
	}
	if err := s.Migrate(ctx); err == nil {
		t.Fatal("Migrate() succeeded on a newer schema, want an error")
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
			name: "well-known fields",
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
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := openStore(t)
			ctx := context.Background()

			want := newTask(idA, "round trip", tc.fields)
			want.Status = task.StatusDone
			want.CompletedAt = &completed
			if err := want.Validate(); err != nil {
				t.Fatalf("Validate: %v", err)
			}
			if err := s.Add(ctx, want); err != nil {
				t.Fatalf("Add: %v", err)
			}

			got, err := s.Get(ctx, idA)
			if err != nil {
				t.Fatalf("Get: %v", err)
			}
			if got.Title != want.Title || got.Done() != want.Done() {
				t.Errorf("got %+v, want title %q done %v", got, want.Title, want.Done())
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

func TestAddRejectsDuplicateID(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Add(ctx, newTask(idA, "first", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Add(ctx, newTask(idA, "second", nil)); err == nil {
		t.Fatal("Add() accepted a duplicate id, want an error")
	}
}

func TestGetReturnsTombstonedTaskAndNotFound(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	deleted := time.Date(2026, 6, 7, 8, 9, 10, 0, time.UTC)

	tombstoned := newTask(idA, "removed", nil)
	tombstoned.DeletedAt = &deleted
	if err := s.Add(ctx, tombstoned); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, err := s.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.Deleted() || !got.DeletedAt.Equal(deleted) {
		t.Errorf("DeletedAt = %v, want %v", got.DeletedAt, deleted)
	}
	if _, err := s.Get(ctx, idC); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestFindByPrefix(t *testing.T) {
	ctx := context.Background()
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
			s := openStore(t)
			for _, taskID := range tc.ids {
				if err := s.Add(ctx, newTask(taskID, "t", nil)); err != nil {
					t.Fatalf("Add: %v", err)
				}
			}
			got, err := s.FindByPrefix(ctx, tc.prefix)
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
	ctx := context.Background()

	// pending, completed and tombstoned, in a known creation order.
	seed := func(t *testing.T) (*Store, map[string]string) {
		t.Helper()
		s := openStore(t)
		ids := map[string]string{}
		base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

		// Literal ids, in ascending order, so that creation order is
		// deterministic even for tasks added in the same millisecond.
		order := []string{idA, idB, idC}
		for i, name := range []string{"pending", "completed", "deleted"} {
			taskID := order[i]
			ids[name] = taskID
			tk := newTask(taskID, name, nil)
			// Reverse the update order relative to creation order, so that
			// OrderUpdated and OrderCreated cannot agree by accident.
			tk.UpdatedAt = base.Add(time.Duration(3-i) * time.Hour)
			switch name {
			case "completed":
				tk.Status = task.StatusDone
				at := base
				tk.CompletedAt = &at
			case "deleted":
				at := base
				tk.DeletedAt = &at
			}
			if err := s.Add(ctx, tk); err != nil {
				t.Fatalf("Add: %v", err)
			}
		}
		return s, ids
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
			name:   "a status filter of active excludes the completed and the tombstoned",
			filter: store.Filter{Statuses: []task.Status{task.StatusActive}},
			want:   []string{"pending"},
		},
		{
			name:   "completed only",
			filter: store.Filter{Statuses: []task.Status{task.StatusDone}},
			want:   []string{"completed"},
		},
		{
			name:   "no status filter, tombstone still excluded",
			filter: store.Filter{},
			want:   []string{"pending", "completed"},
		},
		{
			name:   "tombstone included",
			filter: store.Filter{IncludeDeleted: true},
			want:   []string{"pending", "completed", "deleted"},
		},
		{
			name:   "limit",
			filter: store.Filter{IncludeDeleted: true, Limit: 2},
			want:   []string{"pending", "completed"},
		},
		{
			name:   "order by update time",
			filter: store.Filter{IncludeDeleted: true, Order: store.OrderUpdated},
			want:   []string{"deleted", "completed", "pending"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := seed(t)
			got, err := s.List(ctx, tc.filter)
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
			}
		})
	}
}

func TestListCreationOrderUsesGeneratedIDs(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()

	var want []string
	for i := 0; i < 5; i++ {
		taskID := id.New()
		want = append(want, taskID)
		if err := s.Add(ctx, newTask(taskID, "t", nil)); err != nil {
			t.Fatalf("Add: %v", err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	got, err := s.List(ctx, store.Filter{Order: store.OrderCreated})
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
	s := openStore(t)
	ctx := context.Background()

	original := newTask(idA, "write the provider", task.Fields{task.KeyPriority: 1})
	if err := s.Add(ctx, original); err != nil {
		t.Fatalf("Add: %v", err)
	}

	edited := original.Clone()
	edited.Title = "write the provider tests"
	edited.UpdatedAt = original.UpdatedAt.Add(time.Hour)
	edited.SetStatus(task.StatusDone, edited.UpdatedAt)
	edited.Fields.Set(task.KeyPriority, 3)
	edited.Fields.Set("owner", "sam")
	if err := s.Update(ctx, edited); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := s.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != edited.Title || !got.Done() {
		t.Errorf("got %q done=%v, want %q done=true", got.Title, got.Done(), edited.Title)
	}
	if !reflect.DeepEqual(got.Fields, edited.Fields) {
		t.Errorf("Fields = %#v, want %#v", got.Fields, edited.Fields)
	}

	unknown := newTask(idC, "never stored", nil)
	if err := s.Update(ctx, unknown); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Update(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestPurge(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Add(ctx, newTask(idA, "temporary", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := s.Purge(ctx, idA); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if _, err := s.Get(ctx, idA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Get after Purge error = %v, want ErrNotFound", err)
	}
	if err := s.Purge(ctx, idA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("Purge(unknown) error = %v, want ErrNotFound", err)
	}
}

func TestPersistenceAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	ctx := context.Background()

	first, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := first.Init(ctx); err != nil {
		t.Fatalf("Init: %v", err)
	}
	fields := task.Fields{"nested": map[string]any{"list": []any{1, 2.5, "three"}}}
	if err := first.Add(ctx, newTask(idA, "survives", fields)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()
	if err := second.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	got, err := second.Get(ctx, idA)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(got.Fields, fields) {
		t.Errorf("Fields = %#v, want %#v", got.Fields, fields)
	}
}

func TestOpenExistingOnAMissingFileCreatesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "stray")
	path := filepath.Join(dir, "tasks.db")

	s, err := OpenExisting(path)
	if err == nil {
		s.Close()
		t.Fatalf("OpenExisting(%s) succeeded, want ErrNotInitialized", path)
	}
	if !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("OpenExisting error = %v, want ErrNotInitialized", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("database file exists after OpenExisting: stat err = %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("parent directory exists after OpenExisting: stat err = %v", err)
	}
}

func TestOpenExistingOnAMemoryPathIsNotInitialized(t *testing.T) {
	s, err := OpenExisting(MemoryPath)
	if err == nil {
		s.Close()
		t.Fatalf("OpenExisting(%s) succeeded, want ErrNotInitialized", MemoryPath)
	}
	if !errors.Is(err, store.ErrNotInitialized) {
		t.Fatalf("OpenExisting error = %v, want ErrNotInitialized", err)
	}
}

func TestOpenExistingWithoutASchemaReportsNotInitialized(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")
	ctx := context.Background()

	// An empty but valid database file: opened for creation, never initialized.
	created, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := created.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s, err := OpenExisting(path)
	if err != nil {
		t.Fatalf("OpenExisting: %v", err)
	}
	defer s.Close()

	ops := []struct {
		name string
		run  func() error
	}{
		{"Get", func() error { _, err := s.Get(ctx, idA); return err }},
		{"FindByPrefix", func() error { _, err := s.FindByPrefix(ctx, "01J3"); return err }},
		{"List", func() error { _, err := s.List(ctx, store.Filter{}); return err }},
		{"Update", func() error { return s.Update(ctx, newTask(idA, "nope", nil)) }},
		{"Purge", func() error { return s.Purge(ctx, idA) }},
		{"Add", func() error { return s.Add(ctx, newTask(idA, "nope", nil)) }},
		{"SchemaVersion", func() error { _, err := s.SchemaVersion(ctx); return err }},
		{"Ping", func() error { return s.Ping(ctx) }},
	}
	for _, op := range ops {
		err := op.run()
		if !errors.Is(err, store.ErrNotInitialized) {
			t.Errorf("%s error = %v, want ErrNotInitialized", op.name, err)
			continue
		}
		if strings.Contains(err.Error(), "no such table") {
			t.Errorf("%s leaks the driver message: %v", op.name, err)
		}
	}
}

func TestOpenNeverOverwritesANonDatabaseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.txt")
	content := []byte("this is not a database\n")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	for _, tc := range []struct {
		name string
		open func(string) (*Store, error)
	}{
		{"Open", Open},
		{"OpenExisting", OpenExisting},
	} {
		s, err := tc.open(path)
		if err == nil {
			s.Close()
			t.Errorf("%s(%s) succeeded on a non-database file", tc.name, path)
		}
		got, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("ReadFile: %v", readErr)
		}
		if !bytes.Equal(got, content) {
			t.Errorf("%s changed the file: %q, want %q", tc.name, got, content)
		}
	}
}

// TestReadWriteDSNRefusesToCreate pins the driver behaviour OpenExisting
// relies on as its second line of defence: the DSN itself must fail rather
// than create the file.
func TestReadWriteDSNRefusesToCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tasks.db")

	s, err := open(path, "file:"+path+"?mode=rw")
	if err == nil {
		s.Close()
		t.Fatalf("mode=rw created %s; OpenExisting must rely on its os.Stat guard alone", path)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("mode=rw created the file: stat err = %v", err)
	}
}
