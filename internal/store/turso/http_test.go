package turso

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/secret"
	"github.com/soya-miyoshi/todocloud/internal/store"
)

// This package must only ever talk to the pipeline endpoint of the host it
// was configured with. It has no code that reaches Turso's platform API, so
// no command can create, rename or destroy a database — and this test is
// what keeps that true as the package grows: it exercises every method and
// asserts on every request that left.
func TestEveryRequestGoesToThePipelineEndpointAndNowhereElse(t *testing.T) {
	s, f := openStore(t)
	ctx := t.Context()

	// One of everything the Store interface offers.
	_ = s.Init(ctx)
	_ = s.Migrate(ctx)
	_, _ = s.SchemaVersion(ctx)
	_ = s.Ping(ctx)
	_ = s.Add(ctx, newTask(idA, "a task", nil))
	_, _ = s.Get(ctx, idA)
	_, _ = s.FindByPrefix(ctx, "01J3A")
	_, _ = s.List(ctx, store.Filter{})
	_ = s.Update(ctx, newTask(idA, "edited", nil))
	_ = s.Move(ctx, idA, "", 1, testNow)
	_, _ = s.Children(ctx, "")
	_, _ = s.Subtree(ctx, idA)
	_, _ = s.Availability(ctx, testNow, idA)
	_, _ = s.Tags(ctx)
	_ = s.SavePerspective(ctx, &store.Perspective{Name: "next", UpdatedAt: testNow})
	_, _ = s.Perspective(ctx, "next")
	_, _ = s.Perspectives(ctx)
	_ = s.DeletePerspective(ctx, "next")
	_ = s.Purge(ctx, idA)
	_, _ = s.PurgeSubtree(ctx, idA)

	seen := f.seen()
	if len(seen) < 10 {
		t.Fatalf("only %d request(s) were recorded; the test is not exercising the methods", len(seen))
	}
	for i, req := range seen {
		if req.Method != http.MethodPost {
			t.Errorf("request %d used %s, want POST", i, req.Method)
		}
		if req.Path != pipelinePath {
			t.Errorf("request %d went to %q; the only endpoint this package may use is %q", i, req.Path, pipelinePath)
		}
		if req.RawQuery != "" {
			t.Errorf("request %d carried a query string %q", i, req.RawQuery)
		}
		// A platform-API call would be recognisable by its path. Spelling
		// the forbidden shapes out keeps the invariant readable.
		for _, forbidden := range []string{"/v1/organizations", "/databases", "/instances"} {
			if strings.Contains(req.Path, forbidden) {
				t.Errorf("request %d reached the Turso platform API: %q", i, req.Path)
			}
		}
	}
}

// The token travels in the Authorization header and nowhere else: not in the
// path, not in a query string, not in the request body.
func TestTheTokenTravelsOnlyInTheAuthorizationHeader(t *testing.T) {
	s, f := openStore(t)
	if err := s.Add(t.Context(), newTask(idA, "a task", nil)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	for i, req := range f.seen() {
		if req.Auth != "Bearer "+testToken {
			t.Errorf("request %d sent Authorization %q, want the bearer token", i, req.Auth)
		}
		if strings.Contains(req.RequestURI, testToken) {
			t.Errorf("request %d put the token in the URL: %q", i, req.RequestURI)
		}
		if strings.Contains(req.Body, testToken) {
			t.Errorf("request %d put the token in the body", i)
		}
	}
}

// A store configured without a token sends no Authorization header at all,
// rather than an empty one: a self-hosted sqld may want no auth, and an
// empty bearer is a confusing thing to debug.
func TestNoTokenSendsNoAuthorizationHeader(t *testing.T) {
	f := newFakeServer(t)
	cfg := f.config()
	cfg.Token = secret.Secret{}
	s, err := Open(cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if err := s.Init(t.Context()); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if auth := f.seen()[0].Auth; auth != "" {
		t.Errorf("Authorization = %q, want it absent", auth)
	}
}

// Every way the far end can disappoint us has to become an error a person can
// act on, and none of them may leak the credential.
func TestHTTPFailureModes(t *testing.T) {
	tests := []struct {
		name     string
		handler  func(w http.ResponseWriter, r *http.Request)
		wantCode int
		wantText string
	}{
		{
			name: "a rejected token points at tdo login",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			},
			wantCode: exit.Config,
			wantText: "tdo login",
		},
		{
			name: "a forbidden token is also a credential problem",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "forbidden", http.StatusForbidden)
			},
			wantCode: exit.Config,
			wantText: "tdo login",
		},
		{
			name: "a missing endpoint names the path that was tried",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "nope", http.StatusNotFound)
			},
			wantCode: exit.Provider,
			wantText: pipelinePath,
		},
		{
			name: "a server error reports the status",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "boom", http.StatusInternalServerError)
			},
			wantCode: exit.Provider,
			wantText: "HTTP 500",
		},
		{
			name: "an HTML error page from a proxy is summarised, not pasted",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(http.StatusBadGateway)
				io.WriteString(w, "<html><head><title>502 Bad Gateway</title></head><body>"+
					strings.Repeat("padding ", 4000)+"</body></html>")
			},
			wantCode: exit.Provider,
			wantText: "HTTP 502",
		},
		{
			name: "an HTML page with a 200 is not a pipeline reply",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				io.WriteString(w, "<html><body>hello</body></html>")
			},
			wantCode: exit.Provider,
			wantText: "not a libSQL pipeline reply",
		},
		{
			name: "a truncated body is reported as truncated",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"results":[{"type":"ok","respo`)
			},
			wantCode: exit.Provider,
			wantText: "ended before it was complete",
		},
		{
			name: "an empty body is not a pipeline reply either",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
			},
			wantCode: exit.Provider,
			wantText: "ended before it was complete",
		},
		{
			name: "a pipeline-level error is reported",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"error":{"message":"stream expired"}}`)
			},
			wantCode: exit.Provider,
			wantText: "refused the request",
		},
		{
			name: "fewer results than statements is reported",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"results":[]}`)
			},
			wantCode: exit.Provider,
			wantText: "answered 0 statement(s)",
		},
		{
			name: "an ok result with no result object is reported",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				// One result per statement the listing sends, all of them
				// malformed in the same way.
				io.WriteString(w, `{"results":[{"type":"ok"},{"type":"ok"},{"type":"ok"}]}`)
			},
			wantCode: exit.Provider,
			wantText: "no result",
		},
		{
			name: "a statement the engine refused becomes a provider error",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"results":[{"type":"error","error":{"message":"database is locked","code":"SQLITE_BUSY"}},`+
					`{"type":"error","error":{"message":"database is locked","code":"SQLITE_BUSY"}},`+
					`{"type":"error","error":{"message":"database is locked","code":"SQLITE_BUSY"}}]}`)
			},
			wantCode: exit.Provider,
			wantText: "database is locked",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(tc.handler))
			defer srv.Close()

			s, err := Open(Config{URL: srv.URL, Token: tokenForTest(), HTTPClient: srv.Client()})
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer s.Close()

			_, err = s.List(t.Context(), store.Filter{})
			if err == nil {
				t.Fatal("List() succeeded, want an error")
			}
			if code, _ := exit.Classify(err); code != tc.wantCode {
				t.Errorf("exit code %d, want %d (error: %v)", code, tc.wantCode, err)
			}
			if !strings.Contains(err.Error(), tc.wantText) {
				t.Errorf("error %q does not mention %q", err, tc.wantText)
			}
			if strings.Contains(err.Error(), testToken) {
				t.Errorf("the error leaks the credential: %v", err)
			}
		})
	}
}

// A host that is not listening is a provider error, not a crash, and the
// message names the host rather than the whole request.
func TestAnUnreachableHostIsAProviderError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	client := srv.Client()
	srv.Close() // nothing is listening on that port any more

	s, err := Open(Config{URL: url, Token: tokenForTest(), HTTPClient: client})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	_, err = s.List(t.Context(), store.Filter{})
	if err == nil {
		t.Fatal("List() succeeded against a dead server")
	}
	if code, _ := exit.Classify(err); code != exit.Provider {
		t.Errorf("exit code %d, want %d (error: %v)", code, exit.Provider, err)
	}
	if strings.Contains(err.Error(), testToken) {
		t.Errorf("the error leaks the credential: %v", err)
	}
}

// A cancelled context stops the command and is reported as cancellation,
// not as a provider failure: the caller asked for it.
func TestContextCancellationIsHonoured(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer func() {
		close(release)
		srv.Close()
	}()

	s, err := Open(Config{URL: srv.URL, Token: tokenForTest(), HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err = s.List(ctx, store.Filter{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("List() error = %v, want context.Canceled", err)
	}
}

// A deadline that passes while the server is thinking is reported as the
// deadline, so a slow network does not look like a broken database.
func TestADeadlineIsHonoured(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer func() {
		close(release)
		srv.Close()
	}()

	s, err := Open(Config{URL: srv.URL, Token: tokenForTest(), HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := s.Get(ctx, idA); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Get() error = %v, want context.DeadlineExceeded", err)
	}
}

// Open is offline: a URL alone must not cause a request, so `tdo config` can
// build a store to describe it without touching the network.
func TestOpenMakesNoRequest(t *testing.T) {
	f := newFakeServer(t)
	s, err := Open(f.config())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	if n := len(f.seen()); n != 0 {
		t.Errorf("Open made %d request(s), want none", n)
	}
}

// A URL that cannot be used is a configuration error, so the process exits 3
// with advice rather than 1.
func TestOpenWithABadURLIsAConfigError(t *testing.T) {
	_, err := Open(Config{URL: "ftp://example.turso.io", Token: tokenForTest()})
	if err == nil {
		t.Fatal("Open() accepted an ftp:// URL")
	}
	if code, _ := exit.Classify(err); code != exit.Config {
		t.Errorf("exit code %d, want %d", code, exit.Config)
	}
}
