package turso

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/secret"
	"github.com/soya-miyoshi/todocloud/internal/task"

	_ "modernc.org/sqlite" // the engine the fake server runs statements on
)

// The tests never touch a real Turso account: every one of them runs against
// the fake pipeline server below, which speaks the libSQL remote protocol and
// executes the statements it receives on a private in-memory SQLite database.
//
// Backing the fake with a real engine is the point. A hand-written stub would
// answer whatever the test expected, and the behaviour this provider has to
// reproduce — the ordering, the LIKE ESCAPE semantics, the primary-key
// conflict, "no such table" — is the engine's, not the stub author's.

// testToken is the only token in this package. It is an obvious placeholder:
// nothing here, and nothing in the repository, may contain a realistic one.
const testToken = "TOKEN_GOES_HERE"

// exampleURL is the placeholder database URL used wherever a real-looking
// host would otherwise appear.
const exampleURL = "libsql://example.turso.io"

// recorded is what the fake server remembers about one request, so that a
// test can assert on where the client went and what it sent.
type recorded struct {
	Method     string
	Path       string
	RawQuery   string
	RequestURI string
	Auth       string
	Body       string
}

// fakeServer is an httptest server that answers /v2/pipeline.
type fakeServer struct {
	t   *testing.T
	srv *httptest.Server
	db  *sql.DB

	mu       sync.Mutex
	requests []recorded

	// intercept, when set, replaces the pipeline handler entirely. It is how
	// the HTTP failure modes are driven; returning false falls through to the
	// normal handler.
	intercept func(w http.ResponseWriter, r *http.Request) bool
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open the fake server's engine: %v", err)
	}
	// One connection, because an in-memory database belongs to its
	// connection.
	db.SetMaxOpenConns(1)

	f := &fakeServer{t: t, db: db}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() {
		f.srv.Close()
		db.Close()
	})
	return f
}

// URL is the database URL a Config would carry.
func (f *fakeServer) URL() string { return f.srv.URL }

// seen returns the requests received so far.
func (f *fakeServer) seen() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.requests...)
}

func (f *fakeServer) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.requests = append(f.requests, recorded{
		Method:     r.Method,
		Path:       r.URL.Path,
		RawQuery:   r.URL.RawQuery,
		RequestURI: r.RequestURI,
		Auth:       r.Header.Get("Authorization"),
		Body:       string(body),
	})
	f.mu.Unlock()

	if f.intercept != nil && f.intercept(w, r) {
		return
	}
	if r.URL.Path != pipelinePath {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	var req struct {
		Requests []struct {
			Type string     `json:"type"`
			Stmt *statement `json:"stmt"`
		} `json:"requests"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	resp := pipelineResponse{Results: make([]streamResult, 0, len(req.Requests))}
	for _, one := range req.Requests {
		switch one.Type {
		case "close":
			resp.Results = append(resp.Results, streamResult{
				Type:     "ok",
				Response: &streamResponse{Type: "close"},
			})
		case "execute":
			resp.Results = append(resp.Results, f.execute(one.Stmt))
		default:
			resp.Results = append(resp.Results, streamResult{
				Type:  "error",
				Error: &protoError{Message: "unsupported request type " + one.Type, Code: "UNSUPPORTED"},
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		f.t.Errorf("encode the fake server's response: %v", err)
	}
}

// execute runs one statement on the engine and renders the outcome the way
// the protocol does.
func (f *fakeServer) execute(st *statement) streamResult {
	if st == nil {
		return streamResult{Type: "error", Error: &protoError{Message: "no statement", Code: "ARGS_INVALID"}}
	}
	args := make([]any, 0, len(st.Args))
	for _, a := range st.Args {
		args = append(args, a.Any)
	}

	fail := func(err error) streamResult {
		return streamResult{Type: "error", Error: &protoError{Message: err.Error(), Code: sqliteCode(err)}}
	}

	if isQuery(st.SQL) {
		rows, err := f.db.Query(st.SQL, args...)
		if err != nil {
			return fail(err)
		}
		defer rows.Close()
		cols, err := rows.Columns()
		if err != nil {
			return fail(err)
		}
		result := executeResult{Cols: make([]column, 0, len(cols))}
		for i := range cols {
			name := cols[i]
			result.Cols = append(result.Cols, column{Name: &name})
		}
		for rows.Next() {
			cells := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range cells {
				ptrs[i] = &cells[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				return fail(err)
			}
			if !st.WantRows {
				continue
			}
			row := make([]value, 0, len(cells))
			for _, cell := range cells {
				row = append(row, goToProto(cell))
			}
			result.Rows = append(result.Rows, row)
		}
		if err := rows.Err(); err != nil {
			return fail(err)
		}
		return streamResult{Type: "ok", Response: &streamResponse{Type: "execute", Result: &result}}
	}

	res, err := f.db.Exec(st.SQL, args...)
	if err != nil {
		return fail(err)
	}
	n, _ := res.RowsAffected()
	return streamResult{
		Type: "ok",
		Response: &streamResponse{Type: "execute", Result: &executeResult{
			Rows:             [][]value{},
			AffectedRowCount: n,
		}},
	}
}

func isQuery(sql string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(sql)), "SELECT")
}

// sqliteCode mimics the SQLITE_* code libSQL puts beside the message, so that
// the classification in the provider is exercised on both halves.
func sqliteCode(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "unique constraint failed"):
		return "SQLITE_CONSTRAINT_PRIMARYKEY"
	case strings.Contains(msg, "no such table"):
		return "SQLITE_UNKNOWN"
	default:
		return "SQLITE_UNKNOWN"
	}
}

// goToProto renders a scanned Go value as a protocol value.
func goToProto(v any) value {
	switch t := v.(type) {
	case nil:
		return value{Kind: kindNull}
	case int64:
		return value{Kind: kindInteger, Any: t}
	case float64:
		return value{Kind: kindFloat, Any: t}
	case string:
		return value{Kind: kindText, Any: t}
	case []byte:
		// SQLite hands text columns back as bytes often enough that treating
		// them as text here keeps the fake honest about what a real server
		// sends for a TEXT column.
		return value{Kind: kindText, Any: string(t)}
	case bool:
		var n int64
		if t {
			n = 1
		}
		return value{Kind: kindInteger, Any: n}
	case time.Time:
		return value{Kind: kindText, Any: task.FormatTime(t)}
	default:
		return value{Kind: kindText, Any: ""}
	}
}

// config returns a Config pointed at the fake server.
func (f *fakeServer) config() Config {
	return Config{
		URL:        f.URL(),
		Token:      secret.New(testToken),
		HTTPClient: f.srv.Client(),
	}
}

// openStore returns an initialized store talking to a fresh fake server.
func openStore(t *testing.T) (*Store, *fakeServer) {
	t.Helper()
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.Init(t.Context()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return s, f
}

// Literal ids for the tests that need a deterministic order or a shared
// prefix. They are 26-character Crockford base32, upper case, no I/L/O/U.
const (
	idA  = "01J3ABCDEFGHJKMNPQRSTVWXYZ"
	idB  = "01J3BBCDEFGHJKMNPQRSTVWXYZ"
	idC  = "01J3CBCDEFGHJKMNPQRSTVWXYZ"
	idB2 = "01J3BBCDEFGHJKMNPQRSTVWXY0"
)

// newTask builds a valid action with the given id and user-defined fields.
func newTask(taskID, title string, fields task.Fields) *task.Task {
	t := task.New(taskID, task.KindTask, title, testNow)
	if fields != nil {
		t.Fields = fields
	}
	return t
}

// testNow is the fixed clock every task in this package is built with, so
// that an ordering is an ordering and not a race.
var testNow = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

// tokenForTest returns the placeholder credential. It is a function so that
// every call site reads as "a token", never as a value worth copying.
func tokenForTest() secret.Secret { return secret.New(testToken) }
