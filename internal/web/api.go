package web

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/output"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

// handleState answers with the whole tree, the saved perspectives and the
// tags in one response.
//
// A viewer shows several slices of the same tree at once — a sidebar
// counting the inbox, a list, a detail panel naming the parent — and those
// slices have to agree with each other. One snapshot under one lock is the
// only way they can: fetching them separately would let a write land between
// two of them and leave the page showing a count that contradicts the list
// below it. The tree a person owns is small enough that this is the cheap
// option as well as the correct one.
func (s *Server) handleState(ctx context.Context, _ *http.Request) (any, error) {
	now := s.now()
	// Every status, tombstones excluded: which of them to show is the
	// viewer's decision, and it makes it without asking again.
	tasks, err := taskops.Run(ctx, s.st, taskops.Selection{
		Filter: store.Filter{Order: store.OrderPosition, Now: now},
	})
	if err != nil {
		return nil, err
	}
	av, err := taskops.AvailabilityOf(ctx, s.st, tasks, now)
	if err != nil {
		return nil, err
	}
	perspectives, err := s.st.Perspectives(ctx)
	if err != nil {
		return nil, err
	}
	tags, err := s.st.Tags(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"tasks":        output.Views(tasks, av),
		"count":        len(tasks),
		"perspectives": perspectives,
		"tags":         tags,
		"store":        s.st.Describe(),
		"now":          task.FormatTime(now),
	}, nil
}

// createBody is the JSON `POST /api/tasks` takes. It is Draft in the
// spellings a browser can send: a date as a string, a priority as a number.
type createBody struct {
	Kind     string         `json:"kind"`
	Title    string         `json:"title"`
	ParentID string         `json:"parent_id"`
	Note     string         `json:"note"`
	Tags     []string       `json:"tags"`
	Flagged  bool           `json:"flagged"`
	DeferAt  *string        `json:"defer_at"`
	DueAt    *string        `json:"due_at"`
	Estimate *string        `json:"estimate"`
	Repeat   *string        `json:"repeat"`
	Priority *int           `json:"priority"`
	Set      map[string]any `json:"set"`
}

func (s *Server) handleCreate(ctx context.Context, r *http.Request) (any, error) {
	var body createBody
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if strings.TrimSpace(body.Title) == "" {
		return nil, usagef("a new item needs a title")
	}

	kind := task.KindTask
	if body.Kind != "" {
		kind = task.Kind(body.Kind)
		if !kind.Valid() {
			return nil, usagef("kind must be folder, project or task, got %q", body.Kind)
		}
	}
	d := taskops.Draft{
		Kind:     kind,
		Title:    body.Title,
		ParentID: strings.TrimSpace(body.ParentID),
		Note:     body.Note,
		Tags:     body.Tags,
		Flagged:  body.Flagged,
		Priority: body.Priority,
		Set:      body.Set,
	}
	// The parent arrives as an id from the page, which read it out of a
	// previous state response, so it is resolved rather than trusted: an id
	// the store does not know must be a 404 and not a row with a dangling
	// parent.
	if d.ParentID != "" {
		parent, err := s.st.Get(ctx, d.ParentID)
		if err != nil {
			return nil, err
		}
		d.ParentID = parent.ID
	}
	var err error
	if d.DeferAt, err = parseInstant(body.DeferAt, "defer_at"); err != nil {
		return nil, err
	}
	if d.DueAt, err = parseInstant(body.DueAt, "due_at"); err != nil {
		return nil, err
	}
	if body.Estimate != nil {
		minutes, err := taskops.ParseMinutes(*body.Estimate)
		if err != nil {
			return nil, err
		}
		d.EstimatedMinutes = minutes
	}
	if body.Repeat != nil && strings.TrimSpace(*body.Repeat) != "" {
		repeat, err := taskops.ParseRepeat(*body.Repeat)
		if err != nil {
			return nil, err
		}
		d.Repeat = repeat
	}

	t, err := d.Build(id.New(), s.now())
	if err != nil {
		return nil, err
	}
	if err := taskops.Create(ctx, s.st, t); err != nil {
		return nil, err
	}
	return s.taskPayload(ctx, t)
}

// editBody is the JSON `PATCH /api/tasks/{id}` takes. A field left out is
// left alone; a field present and null clears it. That is the same
// distinction `tdo edit --note ""` relies on, and it is why the pointers are
// pointers.
type editBody struct {
	Title    *string        `json:"title"`
	Note     *string        `json:"note"`
	Tags     *[]string      `json:"tags"`
	Untag    []string       `json:"untag"`
	Estimate *string        `json:"estimate"`
	Priority *int           `json:"priority"`
	Set      map[string]any `json:"set"`
	Unset    []string       `json:"unset"`
	// Flagged is here rather than in Edit because flagging is its own
	// operation in the shared layer, and the inspector sends one request.
	Flagged *bool `json:"flagged"`
}

func (s *Server) handleEdit(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body editBody
	if err := decode(r, &body); err != nil {
		return nil, err
	}

	e := taskops.Edit{
		Title:    body.Title,
		Note:     body.Note,
		Tags:     body.Tags,
		Untag:    body.Untag,
		Priority: body.Priority,
		Set:      body.Set,
		Unset:    body.Unset,
	}
	if body.Estimate != nil {
		minutes, err := taskops.ParseMinutes(*body.Estimate)
		if err != nil {
			return nil, err
		}
		e.EstimatedMinutes = &minutes
	}
	if e.Empty() && body.Flagged == nil {
		return nil, usagef("this request changes nothing")
	}
	if body.Flagged != nil {
		res, err := taskops.SetFlagged(ctx, s.st, []*task.Task{t}, *body.Flagged, s.now())
		if err != nil {
			return nil, err
		}
		t = res.Tasks[0]
	}
	if e.Empty() {
		return s.taskPayload(ctx, t)
	}
	res, err := taskops.Apply(ctx, s.st, []*task.Task{t}, e, s.now())
	if err != nil {
		return nil, err
	}
	return s.taskPayload(ctx, res.Tasks[0])
}

func (s *Server) handleDone(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body struct {
		NoRepeat bool `json:"no_repeat"`
	}
	if err := decodeOptional(r, &body); err != nil {
		return nil, err
	}
	res, err := taskops.Complete(ctx, s.st, []*task.Task{t}, s.now(), body.NoRepeat, id.New)
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

func (s *Server) handleStatus(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	status := task.Status(strings.TrimSpace(body.Status))
	if !status.Valid() {
		return nil, usagef("status must be active, on_hold, done or dropped, got %q", body.Status)
	}
	if status == task.StatusDone {
		// Completing is never a plain status change: a repeating item owes a
		// successor, and §3.4 says where it comes from.
		return nil, usagef("completing an item goes through /api/tasks/{id}/done, so a repeat gets its successor")
	}
	res, err := taskops.SetStatus(ctx, s.st, []*task.Task{t}, status, s.now())
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

func (s *Server) handleFlag(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body struct {
		Flagged bool `json:"flagged"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	res, err := taskops.SetFlagged(ctx, s.st, []*task.Task{t}, body.Flagged, s.now())
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

func (s *Server) handleDate(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body struct {
		Field string  `json:"field"`
		At    *string `json:"at"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	var field taskops.DateField
	switch strings.TrimSpace(body.Field) {
	case string(taskops.DeferDate):
		field = taskops.DeferDate
	case string(taskops.DueDate):
		field = taskops.DueDate
	default:
		return nil, usagef("field must be defer or due, got %q", body.Field)
	}
	at, err := parseInstant(body.At, "at")
	if err != nil {
		return nil, err
	}
	res, err := taskops.SetDate(ctx, s.st, []*task.Task{t}, field, at, s.now())
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

func (s *Server) handleMove(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	var body struct {
		// ParentID empty means the top level, which for a task is the
		// inbox: it is how the viewer unfiles something.
		ParentID string `json:"parent_id"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	parentID := strings.TrimSpace(body.ParentID)
	if parentID != "" {
		parent, err := s.st.Get(ctx, parentID)
		if err != nil {
			return nil, err
		}
		parentID = parent.ID
	}
	res, err := taskops.MoveTo(ctx, s.st, []*task.Task{t}, parentID, s.now())
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

// handleRemove is the ordinary removal: a tombstone, taking the subtree with
// it. There is no purge here. It is the one irreversible path in the CLI and
// the one that asks for confirmation at a terminal (§4.2); a button in a
// browser is not that, and `tdo rm --purge` is a command away.
func (s *Server) handleRemove(ctx context.Context, r *http.Request) (any, error) {
	t, err := s.task(ctx, r)
	if err != nil {
		return nil, err
	}
	res, err := taskops.Tombstone(ctx, s.st, []*task.Task{t}, s.now())
	if err != nil {
		return nil, err
	}
	return s.resultPayload(ctx, res)
}

// task reads the {id} of the route. The id is taken as an exact one rather
// than a prefix: a prefix is for a person typing, and the page always has
// the whole thing.
func (s *Server) task(ctx context.Context, r *http.Request) (*task.Task, error) {
	raw := strings.TrimSpace(r.PathValue("id"))
	if !id.Valid(raw) {
		return nil, usagef("%q is not a task id", raw)
	}
	return s.st.Get(ctx, raw)
}

// taskPayload renders one task the way `--json` does, availability included
// — and in the same envelope, `{"tasks":[…],"count":1}`, so the viewer and an
// agent reading the CLI parse one shape rather than two.
func (s *Server) taskPayload(ctx context.Context, t *task.Task) (any, error) {
	av, err := taskops.AvailabilityOf(ctx, s.st, []*task.Task{t}, s.now())
	if err != nil {
		return nil, err
	}
	answer, asked := av[t.ID]
	return map[string]any{
		"tasks": []output.TaskView{output.NewTaskView(t, answer, asked)},
		"count": 1,
	}, nil
}

// resultPayload renders what a write changed, including the rows nobody
// asked for: the successor of a repeat and the containers that closed with
// their last child. The viewer refetches its state afterwards, but it tells
// the user about these, and a silent one would be a surprise later.
func (s *Server) resultPayload(ctx context.Context, res *taskops.Result) (any, error) {
	av, err := taskops.AvailabilityOf(ctx, s.st, res.Tasks, s.now())
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"tasks":               output.Views(res.Tasks, av),
		"count":               len(res.Tasks),
		"repeated":            output.Views(res.Successors, nil),
		"completed_with_last": output.Views(res.AutoCompleted, nil),
	}, nil
}

// parseInstant reads a date from the API in the spellings the CLI accepts. A
// nil pointer leaves the date alone; a pointer to an empty string clears it,
// which is how a browser sends an emptied date field.
func parseInstant(raw *string, field string) (*time.Time, error) {
	if raw == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		return nil, nil
	}
	at, err := task.ParseDue(trimmed)
	if err != nil {
		return nil, usagef("%s: %v", field, err)
	}
	return &at, nil
}

// decodeOptional reads a body that may be absent: the viewer completes an
// item with no payload at all, and an empty body means every default.
func decodeOptional(r *http.Request, v any) error {
	if r.ContentLength == 0 {
		return nil
	}
	return decode(r, v)
}
