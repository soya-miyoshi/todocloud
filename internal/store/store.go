// Package store defines the provider boundary.
//
// Every provider implements Store and nothing provider-specific crosses this
// package: the command layer only ever holds a Store, a task.Task and the
// errors below. Filters here cover the required fields only, because those are
// the ones every provider can push down to the server. Conditions on
// user-defined fields are evaluated on the client (see Condition), which keeps
// the same behaviour on SQLite and on a provider that would demand a composite
// index for it.
//
// Two things in this package are deliberately not an implementation's
// business. The tree rules of PLAN.md §3.1 and the availability rules of §3.3
// are defined here, once, as pure functions over an in-memory tree. A provider
// may push part of either down to the server for speed, but the answer must
// equal what these functions give, and storetest checks that it does.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/task"
)

// Sentinel errors the command layer maps onto exit codes.
var (
	// ErrNotFound is returned when no task matches a reference. Exit 5.
	ErrNotFound = errors.New("task not found")
	// ErrAmbiguous is returned when an id prefix matches several tasks.
	// Exit 6.
	ErrAmbiguous = errors.New("ambiguous task id")
	// ErrNotInitialized is returned when the provider holds no schema yet.
	// Exit 3.
	ErrNotInitialized = errors.New("store is not initialized; run `tdo init`")
	// ErrExists is returned when a task with that id is already stored. It
	// lets a caller decide: `tdo import` counts it as skipped.
	ErrExists = errors.New("task already exists")
	// ErrBadParent is returned when the parent's kind may not contain the
	// child's — a project under a project, a task under a folder. Exit 2.
	ErrBadParent = errors.New("this kind of item cannot go there")
	// ErrCycle is returned when a move would make an item its own ancestor.
	// A broken tree is worse than a rejected command. Exit 2.
	ErrCycle = errors.New("that move would put an item inside itself")
	// ErrNotEmpty is returned by Purge on a container that still has
	// children. `tdo rm --purge --recursive` is the way to mean it.
	ErrNotEmpty = errors.New("container is not empty")
)

// Order selects the sort order of a listing.
type Order string

const (
	// OrderPosition is tree order: siblings by position, ties by id. It is
	// the default, because it is the order the user arranged.
	OrderPosition Order = "position"
	// OrderCreated sorts by id, which is creation order.
	OrderCreated Order = "created"
	// OrderUpdated sorts by updated_at, most recent last.
	OrderUpdated Order = "updated"
	// OrderDue sorts by due_at, soonest first; items with no due date sort
	// last, since a listing by deadline is about the ones that have one.
	OrderDue Order = "due"
	// OrderDefer sorts by defer_at the same way.
	OrderDefer Order = "defer"
)

// Valid reports whether o is a known order.
func (o Order) Valid() bool {
	switch o {
	case "", OrderPosition, OrderCreated, OrderUpdated, OrderDue, OrderDefer:
		return true
	}
	return false
}

// AvailabilityFilter narrows a listing by the computation of §3.3.
type AvailabilityFilter string

const (
	// AvailabilityAny does not filter on availability.
	AvailabilityAny AvailabilityFilter = ""
	// AvailabilityAvailable keeps only items that can be worked on now. It
	// is what `tdo ls` asks for.
	AvailabilityAvailable AvailabilityFilter = "available"
	// AvailabilityBlocked keeps only items that cannot, for any reason.
	AvailabilityBlocked AvailabilityFilter = "blocked"
	// AvailabilityDeferred keeps only items held back by a defer date,
	// their own or an ancestor's. It backs `tdo ls --deferred`, which asks
	// what is waiting rather than what is stuck.
	AvailabilityDeferred AvailabilityFilter = "deferred"
)

// Valid reports whether a is a known availability filter.
func (a AvailabilityFilter) Valid() bool {
	switch a {
	case AvailabilityAny, AvailabilityAvailable, AvailabilityBlocked, AvailabilityDeferred:
		return true
	}
	return false
}

// Scope selects a slice of the tree.
type Scope struct {
	// ParentID restricts the listing to the direct children of this id. The
	// empty string with Set true means the top level.
	ParentID string `json:"parent_id,omitempty"`
	// Children is true when ParentID is meaningful, so that "children of the
	// top level" is expressible and distinct from "anywhere".
	Children bool `json:"children,omitempty"`
	// Subtree restricts the listing to this id and everything beneath it.
	Subtree string `json:"subtree,omitempty"`
	// Inbox keeps only loose actions: tasks with no parent.
	Inbox bool `json:"inbox,omitempty"`
}

// Empty reports whether s restricts nothing.
func (s Scope) Empty() bool {
	return !s.Children && s.Subtree == "" && !s.Inbox
}

// Filter describes a listing. Only required fields appear here; a condition
// on a user-defined field is a Condition, applied on the client.
//
// A zero Filter matches every live task in tree order. In particular an empty
// Statuses matches every status: the command layer, not the store, decides
// that `tdo ls` means active and on hold. The struct is JSON-serialisable
// because a perspective is exactly a stored Filter (§3.6).
type Filter struct {
	Kinds        []task.Kind        `json:"kinds,omitempty"`
	Statuses     []task.Status      `json:"statuses,omitempty"`
	Availability AvailabilityFilter `json:"availability,omitempty"`
	// Flagged keeps flagged items when true and unflagged ones when false;
	// nil does not filter.
	Flagged *bool    `json:"flagged,omitempty"`
	Scope   Scope    `json:"scope,omitzero"`
	Tags    []string `json:"tags,omitempty"`
	// TagsAny keeps an item carrying any one of Tags rather than all of
	// them. Tags are compared case-insensitively.
	TagsAny bool `json:"tags_any,omitempty"`

	DeferBefore *time.Time `json:"defer_before,omitempty"`
	DeferAfter  *time.Time `json:"defer_after,omitempty"`
	DueBefore   *time.Time `json:"due_before,omitempty"`
	DueAfter    *time.Time `json:"due_after,omitempty"`
	// HasDue keeps only items with a due date when true, only items without
	// one when false.
	HasDue *bool `json:"has_due,omitempty"`
	// ReviewDueBefore keeps folders and projects whose derived
	// next_review_at falls before this instant, including those never
	// reviewed. It backs `tdo review`.
	ReviewDueBefore *time.Time `json:"review_due_before,omitempty"`

	// IncludeDeleted widens the listing to tombstoned items; OnlyDeleted
	// narrows it to them, for `tdo ls --deleted`.
	IncludeDeleted bool `json:"include_deleted,omitempty"`
	OnlyDeleted    bool `json:"only_deleted,omitempty"`

	Order Order `json:"order,omitempty"`
	// Limit caps the number of tasks returned; zero means no limit. It is
	// applied by the store, after its own filtering but before any
	// client-side Condition, so callers that use one should leave it zero.
	Limit int `json:"limit,omitempty"`

	// Now is the instant availability, defer and review windows are judged
	// against. A zero value means the store reads the clock itself; a test
	// sets it so that a truth table is a truth table and not a race.
	Now time.Time `json:"-"`
}

// At returns the instant the filter judges time-dependent rules at.
func (f Filter) At() time.Time {
	if f.Now.IsZero() {
		return time.Now().UTC()
	}
	return f.Now.UTC()
}

// Validate reports a filter a provider could not honour. It exists so that a
// bad perspective is a usage error at the point it is read, rather than a
// listing that quietly means something else.
func (f Filter) Validate() error {
	for _, k := range f.Kinds {
		if !k.Valid() {
			return fmt.Errorf("filter: kind %q is not one of folder, project or task", k)
		}
	}
	for _, s := range f.Statuses {
		if !s.Valid() {
			return fmt.Errorf("filter: status %q is not one of active, on_hold, done or dropped", s)
		}
	}
	if !f.Availability.Valid() {
		return fmt.Errorf("filter: availability %q is not one of available, blocked or deferred", f.Availability)
	}
	if !f.Order.Valid() {
		return fmt.Errorf("filter: order %q is not one of position, created, updated, due or defer", f.Order)
	}
	if f.Limit < 0 {
		return fmt.Errorf("filter: limit must not be negative, got %d", f.Limit)
	}
	return nil
}

// Perspective is a saved query: a name plus the filter a command line could
// have expressed (§3.6). It never stores results and never pins ids, so it
// cannot go stale; running one is exactly equivalent to typing its filter.
type Perspective struct {
	Name      string    `json:"name"`
	Filter    Filter    `json:"filter"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// TagCount is one tag and how many live tasks carry it.
type TagCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Store is one place tasks live. Implementations must be safe to use from a
// single goroutine; the CLI never shares one across goroutines.
//
// Every id-addressed method normalises the id it is given the way
// id.Normalize does, because base32 is case-insensitive and a pasted id may
// arrive lower-cased. A provider that skips that on one method makes rows
// written through another unreachable.
type Store interface {
	// Init creates the schema. It is idempotent.
	Init(ctx context.Context) error

	// SchemaVersion reports the schema version recorded in the store, or
	// ErrNotInitialized when there is none.
	SchemaVersion(ctx context.Context) (int, error)

	// Migrate upgrades an existing store to the version this binary expects.
	Migrate(ctx context.Context) error

	// Add stores a new task, tags included. The caller sets the id and the
	// timestamps. It enforces the tree rules: ErrBadParent when the parent's
	// kind may not contain this one, ErrNotFound when the parent is unknown,
	// ErrExists when the id is taken.
	Add(ctx context.Context, t *task.Task) error

	// Get returns the task with exactly this id, including a tombstoned one.
	Get(ctx context.Context, id string) (*task.Task, error)

	// FindByPrefix returns the single task whose id starts with prefix, or
	// ErrNotFound / ErrAmbiguous.
	FindByPrefix(ctx context.Context, prefix string) (*task.Task, error)

	// List returns the tasks matching f, sorted as f requests.
	List(ctx context.Context, f Filter) ([]*task.Task, error)

	// Update replaces the stored task with t, matched by id, tags included.
	// It enforces the same tree rules as Add, plus ErrCycle when the new
	// parent is t itself or one of its descendants.
	Update(ctx context.Context, t *task.Task) error

	// Move reparents a task and sets its position in one step. An empty
	// parentID moves it to the top level, which for a task is the inbox. It
	// returns ErrBadParent, ErrCycle or ErrNotFound as Update does, and it
	// touches nothing else about the task but updated_at.
	Move(ctx context.Context, id, parentID string, position int, now time.Time) error

	// Children returns the direct children of parentID, in tree order,
	// tombstoned ones included: a caller asking what is inside a container
	// is usually about to delete or move it. An empty parentID returns the
	// top level.
	Children(ctx context.Context, parentID string) ([]*task.Task, error)

	// Subtree returns id and everything beneath it, in pre-order, so that a
	// caller tombstoning a container can see exactly what it is about to
	// take with it. It returns ErrNotFound when id is unknown.
	Subtree(ctx context.Context, id string) ([]*task.Task, error)

	// Availability computes §3.3 for each id over the whole tree, which is
	// why it is a store call and not something the caller can do with a
	// listing: the ancestors of a listed item may not be in the listing. An
	// unknown id is absent from the result rather than an error, so a caller
	// may ask about a stale reference. A zero now means the current time.
	Availability(ctx context.Context, now time.Time, ids ...string) (map[string]Availability, error)

	// Purge removes a task irreversibly. Ordinary removal is an Update that
	// sets the tombstone, so that multi-device sync stays possible. It
	// returns ErrNotEmpty when the task still has children, tombstoned ones
	// included: purging a container would otherwise orphan them.
	Purge(ctx context.Context, id string) error

	// PurgeSubtree removes a task and everything beneath it irreversibly and
	// returns how many rows went. It is what `tdo rm --purge --recursive`
	// calls, and the only way to purge a container.
	PurgeSubtree(ctx context.Context, id string) (int, error)

	// Tags returns every tag in use on a live task with its count, sorted by
	// name.
	Tags(ctx context.Context) ([]TagCount, error)

	// SavePerspective stores a perspective, replacing one of the same name.
	// Names are compared case-insensitively, since they are typed.
	SavePerspective(ctx context.Context, p *Perspective) error

	// Perspective returns one by name, or ErrNotFound.
	Perspective(ctx context.Context, name string) (*Perspective, error)

	// Perspectives returns all of them, sorted by name.
	Perspectives(ctx context.Context) ([]*Perspective, error)

	// DeletePerspective removes one by name, or returns ErrNotFound. A
	// perspective is a query, so there is no tombstone to keep.
	DeletePerspective(ctx context.Context, name string) error

	// Describe returns a short, credential-free description of where the
	// tasks are, for `tdo config` and `tdo doctor`.
	Describe() string

	// Ping checks that the store is reachable and initialized.
	Ping(ctx context.Context) error

	// Close releases resources.
	Close() error
}

// Condition is a client-side filter over the user-defined fields. Everything
// a provider can index lives in Filter; this is the rest.
type Condition struct {
	// MinPriority keeps tasks at or above this priority.
	MinPriority int
	// Match requires the field at each key to equal the given value, as
	// rendered by fmt. It backs `--where key=value`.
	Match map[string]string
}

// Empty reports whether c filters nothing out.
func (c Condition) Empty() bool {
	return c.MinPriority == 0 && len(c.Match) == 0
}

// Matches reports whether t satisfies c.
func (c Condition) Matches(t *task.Task) bool {
	if c.MinPriority > 0 && t.Fields.Priority() < c.MinPriority {
		return false
	}
	for key, want := range c.Match {
		if !fieldEquals(t, key, want) {
			return false
		}
	}
	return true
}

func fieldEquals(t *task.Task, key, want string) bool {
	switch key {
	case task.KeyID:
		return t.ID == want
	case task.KeyTitle:
		return t.Title == want
	case task.KeyKind:
		return string(t.Kind) == want
	case task.KeyStatus:
		return string(t.Status) == want
	}
	if s, ok := t.Fields.String(key); ok {
		return s == want
	}
	if n, ok := t.Fields.Int(key); ok {
		if parsed := task.ParseValue(want); parsed != nil {
			if p, isInt := parsed.(int); isInt {
				return n == p
			}
		}
		return false
	}
	if b, ok := t.Fields.Bool(key); ok {
		parsed := task.ParseValue(want)
		p, isBool := parsed.(bool)
		return isBool && b == p
	}
	return false
}

// Apply filters and limits tasks on the client side.
func Apply(tasks []*task.Task, c Condition, limit int) []*task.Task {
	out := make([]*task.Task, 0, len(tasks))
	for _, t := range tasks {
		if !c.Matches(t) {
			continue
		}
		out = append(out, t)
		if limit > 0 && len(out) == limit {
			break
		}
	}
	return out
}

// SortTasks puts tasks in the order o asks for. pathOf gives the tree-order
// key of a task, as Tree.SortKey builds it; it may be nil for the orders that
// do not need one. A provider that cannot sort the way a filter wants falls
// back to this, and the result is the one the conformance suite expects.
func SortTasks(tasks []*task.Task, o Order, pathOf func(t *task.Task) []string) {
	switch o {
	case OrderUpdated:
		sort.SliceStable(tasks, func(i, j int) bool {
			if !tasks[i].UpdatedAt.Equal(tasks[j].UpdatedAt) {
				return tasks[i].UpdatedAt.Before(tasks[j].UpdatedAt)
			}
			return tasks[i].ID < tasks[j].ID
		})
	case OrderDue:
		sortByTime(tasks, func(t *task.Task) *time.Time { return t.DueAt })
	case OrderDefer:
		sortByTime(tasks, func(t *task.Task) *time.Time { return t.DeferAt })
	case OrderCreated:
		sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
	default: // OrderPosition
		if pathOf == nil {
			sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
			return
		}
		keys := make(map[string][]string, len(tasks))
		for _, t := range tasks {
			keys[t.ID] = pathOf(t)
		}
		sort.SliceStable(tasks, func(i, j int) bool {
			a, b := keys[tasks[i].ID], keys[tasks[j].ID]
			for n := 0; n < len(a) && n < len(b); n++ {
				if a[n] != b[n] {
					return a[n] < b[n]
				}
			}
			if len(a) != len(b) {
				// A container sorts before the items inside it, which is the
				// order the tree is printed in.
				return len(a) < len(b)
			}
			return tasks[i].ID < tasks[j].ID
		})
	}
}

// sortByTime sorts soonest first and puts the unset ones last: a listing by
// deadline is about the items that have one.
func sortByTime(tasks []*task.Task, at func(*task.Task) *time.Time) {
	sort.SliceStable(tasks, func(i, j int) bool {
		a, b := at(tasks[i]), at(tasks[j])
		switch {
		case a == nil && b == nil:
			return tasks[i].ID < tasks[j].ID
		case a == nil:
			return false
		case b == nil:
			return true
		case !a.Equal(*b):
			return a.Before(*b)
		default:
			return tasks[i].ID < tasks[j].ID
		}
	})
}

// MarshalJSON is here so a Filter written into a perspective reads back as
// the same filter. It uses the default encoding; the method exists only to
// document that the shape is part of the stored format and changing a json
// tag above is a breaking change to every saved perspective.
func (f Filter) MarshalJSON() ([]byte, error) {
	type alias Filter
	return json.Marshal(alias(f))
}
