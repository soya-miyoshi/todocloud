package web

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/sqlite"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// harness is a server over a real SQLite store in a temporary directory. No
// test here touches the network: httptest and a local file are the whole
// world, as §6 requires.
type harness struct {
	t   *testing.T
	srv *Server
	st  store.Store
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st, err := sqlite.Open(filepath.Join(t.TempDir(), "tasks.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	srv, err := New(st)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	// A pinned clock, so an availability answer is a truth table and not a
	// race against midnight.
	now := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)
	srv.now = func() time.Time { return now }
	return &harness{t: t, srv: srv, st: st}
}

// do sends a request with the write token attached.
func (h *harness) do(method, path string, body any) (int, map[string]any) {
	h.t.Helper()
	return h.send(method, path, body, h.srv.token, "application/json")
}

func (h *harness) send(method, path string, body any, token, contentType string) (int, map[string]any) {
	h.t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			h.t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if token != "" {
		req.Header.Set("X-Tdo-Token", token)
	}
	if contentType != "" && body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)

	var payload map[string]any
	if trimmed := strings.TrimSpace(rec.Body.String()); trimmed != "" && strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
			h.t.Fatalf("%s %s returned unparseable JSON: %q: %v", method, path, trimmed, err)
		}
	}
	return rec.Code, payload
}

// add captures an item and returns its id.
func (h *harness) add(body map[string]any) string {
	h.t.Helper()
	code, payload := h.do("POST", "/api/tasks", body)
	if code != http.StatusOK {
		h.t.Fatalf("create: status %d: %v", code, payload)
	}
	tasks, ok := payload["tasks"].([]any)
	if !ok || len(tasks) != 1 {
		h.t.Fatalf("a write answers with one task in the listing shape: %v", payload)
	}
	created, ok := tasks[0].(map[string]any)
	if !ok {
		h.t.Fatalf("create: no task in %v", payload)
	}
	id, _ := created["id"].(string)
	if id == "" {
		h.t.Fatalf("create: no id in %v", created)
	}
	return id
}

func (h *harness) tasks() []map[string]any {
	h.t.Helper()
	code, payload := h.send("GET", "/api/state", nil, h.srv.token, "")
	if code != http.StatusOK {
		h.t.Fatalf("state: status %d: %v", code, payload)
	}
	raw, _ := payload["tasks"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		t, _ := item.(map[string]any)
		out = append(out, t)
	}
	return out
}

func (h *harness) find(id string) map[string]any {
	h.t.Helper()
	for _, t := range h.tasks() {
		if t["id"] == id {
			return t
		}
	}
	h.t.Fatalf("%s is not in the state response", id)
	return nil
}

// TestTheStateResponseCarriesTheDerivedKeys is the contract the page is
// written against: one snapshot, with the three derived keys of §3.3 and
// §3.5 already computed, so the browser never recomputes an availability
// rule in JavaScript.
func TestTheStateResponseCarriesTheDerivedKeys(t *testing.T) {
	h := newHarness(t)
	h.add(map[string]any{"title": "write the viewer"})

	code, payload := h.send("GET", "/api/state", nil, h.srv.token, "")
	if code != http.StatusOK {
		t.Fatalf("status %d: %v", code, payload)
	}
	for _, key := range []string{"tasks", "count", "perspectives", "tags", "store", "now"} {
		if _, ok := payload[key]; !ok {
			t.Errorf("the state response is missing %q: %v", key, payload)
		}
	}
	one := h.tasks()[0]
	for _, key := range []string{task.KeyAvailable, task.KeyBlockedBy, task.KeyNextReview} {
		if _, ok := one[key]; !ok {
			t.Errorf("a task in the state response is missing the derived key %q: %v", key, one)
		}
	}
	if one[task.KeyAvailable] != true {
		t.Errorf("a plain captured task should be available: %v", one)
	}
}

// TestAWriteWithoutTheTokenChangesNothing is the reason the editing UI is
// safe to run: another origin's script can reach the port, but it cannot
// read the page, so it cannot have the token.
func TestAWriteWithoutTheTokenChangesNothing(t *testing.T) {
	h := newHarness(t)
	id := h.add(map[string]any{"title": "keep me"})

	for _, token := range []string{"", "not-the-token"} {
		code, _ := h.send("DELETE", "/api/tasks/"+id, nil, token, "")
		if code != http.StatusForbidden {
			t.Fatalf("a write with token %q: status %d, want 403", token, code)
		}
	}
	if h.find(id)["deleted_at"] != nil {
		t.Fatal("a rejected write must not have removed anything")
	}
	// A read is refused the same way, so the list cannot be read by a page
	// that merely knows the port.
	if code, _ := h.send("DELETE", "/api/tasks/"+id, nil, h.srv.token, ""); code != http.StatusOK {
		t.Fatalf("the real token should be accepted: status %d", code)
	}
}

// TestAFormPostIsRefused covers the other half of the same defence: a
// cross-origin HTML form can be submitted without script, but it cannot set
// a content type the API accepts.
func TestAFormPostIsRefused(t *testing.T) {
	h := newHarness(t)
	code, _ := h.send("POST", "/api/tasks", map[string]any{"title": "injected"},
		h.srv.token, "application/x-www-form-urlencoded")
	if code != http.StatusUnsupportedMediaType {
		t.Fatalf("a form-encoded write: status %d, want 415", code)
	}
	if len(h.tasks()) != 0 {
		t.Fatal("a refused write must not have created anything")
	}
}

// TestCompletingARepeatingItemCreatesItsSuccessor is the one write that
// creates a row nobody asked for, and the reason completing is its own
// endpoint rather than a status change.
func TestCompletingARepeatingItemCreatesItsSuccessor(t *testing.T) {
	h := newHarness(t)
	id := h.add(map[string]any{"title": "water the plants", "due_at": "2026-03-03", "repeat": "1w"})

	code, payload := h.do("POST", "/api/tasks/"+id+"/done", map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("done: status %d: %v", code, payload)
	}
	repeated, _ := payload["repeated"].([]any)
	if len(repeated) != 1 {
		t.Fatalf("completing a repeating item should report one successor: %v", payload)
	}
	if h.find(id)["status"] != "done" {
		t.Fatal("the instance should be done")
	}

	// And the status endpoint refuses to be the way round it.
	code, _ = h.do("POST", "/api/tasks/"+id+"/status", map[string]any{"status": "done"})
	if code != http.StatusBadRequest {
		t.Fatalf("completing through the status endpoint: status %d, want 400", code)
	}
}

// TestTheTreeRulesAreTheStoresAnswer: the viewer offers only legal parents,
// but an id can arrive from anywhere, so the refusal has to come from the
// store and arrive as a bad request rather than a server failure.
func TestTheTreeRulesAreTheStoresAnswer(t *testing.T) {
	h := newHarness(t)
	project := h.add(map[string]any{"title": "ship v1", "kind": "project"})
	other := h.add(map[string]any{"title": "ship v2", "kind": "project"})

	if code, payload := h.do("POST", "/api/tasks/"+project+"/move", map[string]any{"parent_id": other}); code != http.StatusBadRequest {
		t.Fatalf("a project under a project: status %d, want 400: %v", code, payload)
	}
	if code, _ := h.do("POST", "/api/tasks/"+project+"/move", map[string]any{"parent_id": project}); code != http.StatusBadRequest {
		t.Fatalf("a move into itself: status %d, want 400", code)
	}
	if code, _ := h.do("POST", "/api/tasks/"+project+"/move", map[string]any{"parent_id": strings.Repeat("0", 26)}); code != http.StatusNotFound {
		t.Fatalf("a move under an unknown parent: status %d, want 404", code)
	}
}

// TestARejectedEditChangesNothing: the shared layer validates a copy, and
// the refusal has to reach the browser as a bad request naming the field.
func TestARejectedEditChangesNothing(t *testing.T) {
	h := newHarness(t)
	id := h.add(map[string]any{"title": "original"})

	cases := []struct {
		name string
		body map[string]any
	}{
		{"an empty title", map[string]any{"title": "   "}},
		{"a priority out of range", map[string]any{"priority": 9}},
		{"a reserved field", map[string]any{"set": map[string]any{"status": "done"}}},
		{"an unknown key", map[string]any{"nonesuch": 1}},
		{"nothing at all", map[string]any{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, payload := h.do("PATCH", "/api/tasks/"+id, c.body)
			if code != http.StatusBadRequest {
				t.Fatalf("status %d, want 400: %v", code, payload)
			}
			if got := h.find(id)["title"]; got != "original" {
				t.Fatalf("the stored item changed anyway: %v", got)
			}
		})
	}
}

// TestRemovingAContainerTakesItsSubtree, and leaves a tombstone rather than
// deleting: there is no purge in this API at all.
func TestRemovingAContainerTakesItsSubtree(t *testing.T) {
	h := newHarness(t)
	project := h.add(map[string]any{"title": "ship v1", "kind": "project"})
	child := h.add(map[string]any{"title": "write the docs", "parent_id": project})

	code, payload := h.do("DELETE", "/api/tasks/"+project, nil)
	if code != http.StatusOK {
		t.Fatalf("remove: status %d: %v", code, payload)
	}
	if count, _ := payload["count"].(float64); count != 2 {
		t.Fatalf("removing a container should report the subtree: %v", payload)
	}
	for _, id := range []string{project, child} {
		stored, err := h.st.Get(context.Background(), id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		if stored.DeletedAt == nil {
			t.Fatalf("%s should carry a tombstone", id)
		}
	}
	// A tombstoned item is gone from the viewer's snapshot: `tdo ls
	// --deleted` is where it still shows.
	if len(h.tasks()) != 0 {
		t.Fatalf("the state response should not list tombstones: %v", h.tasks())
	}
}

// TestABadIDIsAUsageError, not a 404 and not a 500: the page always has the
// whole id, so anything else is a malformed request.
func TestABadIDIsAUsageError(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.do("POST", "/api/tasks/notanid/flag", map[string]any{"flagged": true}); code != http.StatusBadRequest {
		t.Fatalf("a malformed id: status %d, want 400", code)
	}
	if code, _ := h.do("POST", "/api/tasks/"+strings.Repeat("0", 26)+"/flag", map[string]any{"flagged": true}); code != http.StatusNotFound {
		t.Fatalf("an unknown id: status %d, want 404", code)
	}
}

// TestThePageCarriesTheTokenAndNothingElse: the token has to reach the
// script, and the page must not be cached, or a reload after a restart would
// hold one that no longer works.
func TestThePageCarriesTheTokenAndNothingElse(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, h.srv.token) {
		t.Error("the page should carry the write token")
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: %q, want no-store", got)
	}
}

// TestEveryDateSpellingTheCLITakes: the API and the flags accept the same
// values, because both go through the shared parser.
func TestEveryDateSpellingTheCLITakes(t *testing.T) {
	h := newHarness(t)
	id := h.add(map[string]any{"title": "pay the invoice"})

	if code, payload := h.do("POST", "/api/tasks/"+id+"/date", map[string]any{"field": "due", "at": "2026-04-01"}); code != http.StatusOK {
		t.Fatalf("a date-only due: status %d: %v", code, payload)
	}
	if got := h.find(id)["due_at"]; got != "2026-04-01T00:00:00Z" {
		t.Fatalf("due_at: %v", got)
	}
	// An emptied field in the browser clears the date, which is what
	// `--clear` does at the command line.
	if code, _ := h.do("POST", "/api/tasks/"+id+"/date", map[string]any{"field": "due", "at": ""}); code != http.StatusOK {
		t.Fatal("clearing a date should be accepted")
	}
	if got := h.find(id)["due_at"]; got != nil {
		t.Fatalf("due_at after clearing: %v", got)
	}
	if code, _ := h.do("POST", "/api/tasks/"+id+"/date", map[string]any{"field": "due", "at": "next tuesday"}); code != http.StatusBadRequest {
		t.Fatal("an unparseable date should be a bad request")
	}
	if code, _ := h.do("POST", "/api/tasks/"+id+"/date", map[string]any{"field": "someday", "at": "2026-04-01"}); code != http.StatusBadRequest {
		t.Fatal("an unknown date field should be a bad request")
	}
}

// TestShellIsServable covers the files that make the viewer installable. A
// manifest served as text/plain, or an icon that 404s, fails silently in a
// browser: the install option simply never appears.
func TestShellIsServable(t *testing.T) {
	h := newHarness(t)
	for _, c := range []struct {
		path string
		typ  string
	}{
		{"/manifest.webmanifest", "application/manifest+json"},
		{"/sw.js", "text/javascript"},
		{"/icon-192.png", "image/png"},
		{"/icon-512.png", "image/png"},
		{"/apple-touch-icon.png", "image/png"},
	} {
		req := httptest.NewRequest(http.MethodGet, c.path, nil)
		rec := httptest.NewRecorder()
		h.srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200", c.path, rec.Code)
			continue
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, c.typ) {
			t.Errorf("GET %s: content type %q, want %q", c.path, got, c.typ)
		}
		if rec.Body.Len() == 0 {
			t.Errorf("GET %s: empty body", c.path)
		}
	}
}

// TestShellCarriesNoToken keeps the token where it belongs. The page is the
// one file that carries it; a browser may keep any of these others around,
// so none of them may hold anything that expires with the process.
func TestShellCarriesNoToken(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/manifest.webmanifest", "/sw.js", "/app.js", "/app.css"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h.srv.ServeHTTP(rec, req)
		if strings.Contains(rec.Body.String(), h.srv.token) {
			t.Errorf("GET %s: body carries the write token", path)
		}
	}
}

// TestWorkerAnswersNothing holds the worker to what it is for. It is
// registered so the page can be installed to a home screen and for nothing
// else; the moment it answers a request from a cache, the phone can show a
// list the store disagrees with, and no devtools window exists there to find
// out why.
func TestWorkerAnswersNothing(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodGet, "/sw.js", nil)
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)
	// The comments in that file name both of these in explaining why they
	// are absent, so the assertion is about the code and reads past them.
	var code strings.Builder
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "//") {
			code.WriteString(line)
		}
	}
	for _, forbidden := range []string{"respondWith", "caches"} {
		if strings.Contains(code.String(), forbidden) {
			t.Errorf("the service worker uses %s; it is meant to intercept nothing", forbidden)
		}
	}
}
