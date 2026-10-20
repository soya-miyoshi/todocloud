// Package web is the viewer `tdo serve` puts on a local port: a read-write
// browser UI over the same store the CLI writes to.
//
// It is a front end and nothing more. Every read and every write goes through
// internal/taskops, the layer `tdo ls` and `tdo done` go through, so the two
// cannot disagree about what "available" means or about what completing a
// repeating item does. The JSON a task is rendered as is output.TaskView,
// which is the shape docs/agents.md documents for `--json`, so the browser
// and an agent parse the same thing.
//
// Three things are deliberate about the way it listens.
//
// A store is documented as safe for one goroutine, so one mutex serializes
// every request. A local viewer has one user; a queue costs nothing worth
// measuring and removes a whole class of failure.
//
// Writes require a token minted at startup and handed to the page it serves.
// Another origin's script can reach the port — a browser will connect to
// localhost from any page — but it cannot read the response without CORS
// headers, which are never sent, and it cannot guess the token, so it cannot
// write. That is what makes the editing UI safe to run on a shared machine,
// and it is why the token is a header rather than a cookie: a cookie would
// be attached to a cross-origin request automatically, which is the whole
// problem.
//
// The default bind address is loopback. --addr is how a user says they want
// it reachable from the network, and when they do, the warning says what
// they have exposed: the listener is unauthenticated beyond the token, which
// anyone who can load the page is given.
package web

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/taskops"
)

//go:embed assets
var assets embed.FS

// maxBodyBytes caps a request body. Nothing the API accepts is large, and an
// unbounded read is an easy way to make a local process eat memory.
const maxBodyBytes = 1 << 20

// Server serves the viewer over one store.
type Server struct {
	st store.Store
	// mu serializes requests, because a store is documented as safe for a
	// single goroutine only.
	mu sync.Mutex
	// token authorizes a write. It lives for the life of the process and is
	// embedded in the page, so a reload after a restart picks up the new one.
	token string
	// now is the clock, injectable so a test can pin availability.
	now func() time.Time
	mux *http.ServeMux
}

// New builds a server over st. It returns an error only if the embedded
// assets cannot be parsed, which would be a build problem rather than a
// runtime one.
func New(st store.Store) (*Server, error) {
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	s := &Server{st: st, token: token, now: func() time.Time { return time.Now().UTC() }}
	if err := s.routes(); err != nil {
		return nil, err
	}
	return s, nil
}

// newToken mints the write token: 32 bytes of randomness, which is far more
// than a local listener needs and no harder to produce.
func newToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("could not generate the write token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Server) routes() error {
	static, err := fs.Sub(assets, "assets")
	if err != nil {
		return err
	}
	page, err := template.ParseFS(assets, "assets/index.html")
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	// The page is rendered rather than served as a file, because it carries
	// the write token and the store's description.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// The page is this process's own state; a stale copy would hold a
		// token that no longer works.
		w.Header().Set("Cache-Control", "no-store")
		data := map[string]string{"Token": s.token, "Store": s.st.Describe()}
		if err := page.Execute(w, data); err != nil {
			// The response is already begun, so there is nothing to say but
			// to stop writing.
			return
		}
	})
	mux.Handle("GET /app.css", http.FileServerFS(static))
	mux.Handle("GET /app.js", http.FileServerFS(static))

	// The rest of the shell, which exists so the viewer can be installed to
	// a phone's home screen and behave like an app there.
	mux.Handle("GET /icon-192.png", http.FileServerFS(static))
	mux.Handle("GET /icon-512.png", http.FileServerFS(static))
	mux.Handle("GET /apple-touch-icon.png", http.FileServerFS(static))
	// Two files Go has no media type for, and a browser refuses both when
	// they arrive as something else.
	mux.Handle("GET /manifest.webmanifest", file(static, "manifest.webmanifest", "application/manifest+json"))
	// The worker caches nothing (see the file); it is revalidated rather
	// than cached itself, because a stale worker is the one thing a phone
	// cannot be made to let go of.
	mux.Handle("GET /sw.js", file(static, "sw.js", "text/javascript; charset=utf-8"))

	mux.HandleFunc("GET /api/state", s.read(s.handleState))
	mux.HandleFunc("POST /api/tasks", s.write(s.handleCreate))
	mux.HandleFunc("PATCH /api/tasks/{id}", s.write(s.handleEdit))
	mux.HandleFunc("DELETE /api/tasks/{id}", s.write(s.handleRemove))
	mux.HandleFunc("POST /api/tasks/{id}/done", s.write(s.handleDone))
	mux.HandleFunc("POST /api/tasks/{id}/status", s.write(s.handleStatus))
	mux.HandleFunc("POST /api/tasks/{id}/flag", s.write(s.handleFlag))
	mux.HandleFunc("POST /api/tasks/{id}/date", s.write(s.handleDate))
	mux.HandleFunc("POST /api/tasks/{id}/move", s.write(s.handleMove))

	s.mux = mux
	return nil
}

// file serves one embedded asset under a media type of our choosing, for
// the two the standard library's extension table does not know.
func file(static fs.FS, name, contentType string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := fs.ReadFile(static, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	})
}

// ServeHTTP answers a request under the mutex, so the store is only ever
// used by one goroutine at a time.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// handler is one API endpoint: it returns the payload to encode, or an error
// the caller maps onto a status code.
type handler func(ctx context.Context, r *http.Request) (any, error)

// read wraps a GET endpoint: the mutex, and the JSON encoding.
func (s *Server) read(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		payload, err := fn(r.Context(), r)
		s.respond(w, payload, err)
	}
}

// write wraps a mutating endpoint: the token check and a JSON content type,
// then the same. Both checks are about a cross-origin request — a form post
// from another page cannot set either one.
func (s *Server) write(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			httpError(w, http.StatusForbidden, "forbidden",
				"this request carries no valid write token; reload the page")
			return
		}
		if ct := r.Header.Get("Content-Type"); r.ContentLength != 0 && !strings.HasPrefix(ct, "application/json") {
			httpError(w, http.StatusUnsupportedMediaType, "usage",
				"the API takes application/json")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		payload, err := fn(r.Context(), r)
		s.respond(w, payload, err)
	}
}

// authorized compares the token in constant time, so that a wrong guess
// tells the caller nothing about how wrong it was.
func (s *Server) authorized(r *http.Request) bool {
	given := r.Header.Get("X-Tdo-Token")
	return subtle.ConstantTimeCompare([]byte(given), []byte(s.token)) == 1
}

func (s *Server) respond(w http.ResponseWriter, payload any, err error) {
	if err != nil {
		status, code := statusOf(err)
		httpError(w, status, code, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		return
	}
}

// statusOf maps the errors the shared layer returns onto status codes, the
// way internal/exit maps them onto exit codes. The two lists are the same
// failure classes, named for the two front ends.
func statusOf(err error) (int, string) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, store.ErrAmbiguous):
		return http.StatusConflict, "ambiguous"
	case errors.Is(err, store.ErrBadParent), errors.Is(err, store.ErrCycle),
		errors.Is(err, store.ErrNotEmpty), errors.Is(err, taskops.ErrInvalid),
		errors.Is(err, errUsage):
		return http.StatusBadRequest, "usage"
	case errors.Is(err, store.ErrNotInitialized), errors.Is(err, store.ErrSchemaMismatch):
		return http.StatusServiceUnavailable, "config"
	default:
		return http.StatusInternalServerError, "error"
	}
}

// errUsage marks a request this package itself refused, before the shared
// layer saw it: a malformed body, a missing field.
var errUsage = errors.New("bad request")

func usagef(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errUsage, fmt.Sprintf(format, args...))
}

// errorBody is the shape an API failure answers with. It mirrors the error
// envelope of `--json`, so the two are read the same way.
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func httpError(w http.ResponseWriter, status int, code, message string) {
	var body errorBody
	body.Error.Code = code
	body.Error.Message = message
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// decode reads a JSON request body into v, refusing a key it does not know.
// An ignored key would be a silent half-applied edit: the browser would
// report success for a change that never happened.
func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return usagef("could not read the request: %v", err)
	}
	return nil
}

// Listen opens the listener. It is separate from Serve so that `tdo serve`
// can print the address it actually got — port 0 means "any free port", and
// the user needs to be told which one.
func Listen(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}

// Serve answers requests until the context is cancelled, then shuts down.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler: s,
		// A local viewer has no reason to hold a request open for long, and
		// a header timeout is the cheapest protection against a connection
		// that never finishes talking.
		ReadHeaderTimeout: 10 * time.Second,
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()

	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		// A shutdown with a deadline of its own: the parent context is
		// already cancelled, so it cannot be the one that bounds this.
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
		return nil
	}
}
