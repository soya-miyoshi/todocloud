package turso

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/secret"
)

// pipelinePath is the only path this package ever requests. There is no code
// here that reaches the Turso platform API: this provider executes SQL
// against the database its URL names and can neither create nor destroy a
// database. endpointTest asserts that invariant against a recording server.
const pipelinePath = "/v2/pipeline"

// maxErrorBody bounds how much of a failed response is read before it is
// summarised. A server that answers with an HTML error page or an endless
// stream must not be allowed to fill memory on the way to an error message.
const maxErrorBody = 8 << 10

// client speaks the libSQL remote protocol to one database.
type client struct {
	endpoint string
	host     string
	token    secret.Secret
	http     *http.Client
	// owned reports whether http was built here, which decides whether Close
	// may shut its idle connections down.
	owned bool
}

// endpointFor turns a configured database URL into the pipeline endpoint.
//
// A libsql:// URL is the https:// URL of the same host; http:// is accepted
// for a self-hosted sqld and for the tests. A URL carrying a query string,
// a fragment or userinfo is refused outright: Turso's own tooling sometimes
// writes the token into `?authToken=`, and this project does not put a
// credential in a URL — it travels in the Authorization header or not at all.
func endpointFor(raw string) (endpoint, host string, err error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", errors.New("turso: no database URL configured")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", "", fmt.Errorf("turso: invalid database URL %s", clip(trimmed))
	}
	switch strings.ToLower(u.Scheme) {
	case "libsql", "https", "wss":
		u.Scheme = "https"
	case "http", "ws":
		u.Scheme = "http"
	case "":
		return "", "", fmt.Errorf("turso: database URL %s has no scheme; it should look like libsql://example.turso.io", clip(trimmed))
	default:
		return "", "", fmt.Errorf("turso: unsupported database URL scheme %q; use libsql:// or https://", u.Scheme)
	}
	if u.Host == "" {
		return "", "", fmt.Errorf("turso: database URL %s names no host", clip(trimmed))
	}
	if u.User != nil {
		return "", "", errors.New("turso: the database URL must not carry credentials; the token travels in the Authorization header")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return "", "", errors.New("turso: the database URL must not carry a query string; a token in a URL is logged by every proxy in the path")
	}
	if u.Fragment != "" {
		return "", "", errors.New("turso: the database URL must not carry a fragment")
	}
	base := strings.TrimSuffix(u.Path, "/")
	host = u.Host
	return u.Scheme + "://" + u.Host + base + pipelinePath, host, nil
}

// pipeline executes stmts in one round trip and returns one result per
// statement, in order. The stream is opened and closed by this request, so
// the client holds no server-side state between calls: there is no baton to
// track and nothing to leak if the process dies mid-command.
func (c *client) pipeline(ctx context.Context, stmts ...statement) ([]*executeResult, error) {
	body := pipelineRequest{Requests: make([]streamRequest, 0, len(stmts)+1)}
	for i := range stmts {
		body.Requests = append(body.Requests, streamRequest{Type: "execute", Stmt: &stmts[i]})
	}
	body.Requests = append(body.Requests, streamRequest{Type: "close"})

	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("turso: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("turso: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if !c.token.Empty() {
		// The one place the credential is revealed. It never reaches the URL,
		// a log line or an error message.
		req.Header.Set("Authorization", "Bearer "+c.token.Reveal())
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// Cancellation and the deadline are the caller's own doing, so they
		// are reported as themselves rather than as a provider failure.
		if cause := ctx.Err(); cause != nil {
			return nil, fmt.Errorf("turso: request to %s: %w", c.host, cause)
		}
		return nil, exit.Providerf(fmt.Errorf("turso: request to %s: %w", c.host, err))
	}
	defer resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		return nil, c.statusError(resp)
	}

	decoded, err := decodePipelineResponse(io.LimitReader(resp.Body, maxResponseBody))
	if err != nil {
		return nil, exit.Providerf(fmt.Errorf("turso: %s: %w", c.host, err))
	}
	return c.results(decoded, len(stmts))
}

// maxResponseBody bounds a successful response too. A task list is kilobytes;
// anything past this is a server that is not answering the question asked.
const maxResponseBody = 256 << 20

// decodePipelineResponse reads the response body. It is split out so that the
// fuzz target can reach it with no server in the way: it is the only parser in
// this package that reads bytes the CLI did not write.
func decodePipelineResponse(r io.Reader) (*pipelineResponse, error) {
	var out pipelineResponse
	dec := json.NewDecoder(r)
	if err := dec.Decode(&out); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, errors.New("the response ended before it was complete")
		}
		return nil, fmt.Errorf("the response is not a libSQL pipeline reply: %w", err)
	}
	return &out, nil
}

// results checks the per-statement outcomes and returns them aligned with the
// statements that were sent.
func (c *client) results(resp *pipelineResponse, want int) ([]*executeResult, error) {
	if len(resp.Error) > 0 && string(resp.Error) != "null" {
		return nil, exit.Providerf(fmt.Errorf("turso: %s refused the request: %s", c.host, clip(string(resp.Error))))
	}
	// The trailing close request is sent by pipeline, so there is always one
	// result more than there are statements.
	if len(resp.Results) < want {
		return nil, exit.Providerf(fmt.Errorf("turso: %s answered %d statement(s), %d were sent", c.host, len(resp.Results), want))
	}
	out := make([]*executeResult, want)
	for i := 0; i < want; i++ {
		res := resp.Results[i]
		switch res.Type {
		case "error":
			return nil, &remoteError{host: c.host, err: res.Error}
		case "ok":
			if res.Response == nil || res.Response.Result == nil {
				return nil, exit.Providerf(fmt.Errorf("turso: %s returned no result for statement %d", c.host, i+1))
			}
			out[i] = res.Response.Result
		case "":
			return nil, exit.Providerf(fmt.Errorf("turso: %s returned an untyped result for statement %d", c.host, i+1))
		default:
			return nil, exit.Providerf(fmt.Errorf("turso: %s returned an unknown result type %q", c.host, res.Type))
		}
	}
	return out, nil
}

// statusError turns a non-2xx response into the clearest error the status
// allows. 401 and 403 are credential problems and classified as such, so that
// the process exits 3 and the advice points at `tdo login` rather than at the
// network.
func (c *client) statusError(resp *http.Response) error {
	snippet := readSnippet(resp.Body)
	switch resp.StatusCode {
	case http.StatusUnauthorized:
		return exit.Configf(fmt.Errorf("turso: %s rejected the auth token (HTTP 401); run `tdo login` to store a fresh per-database token, or set TODOCLOUD_TURSO_TOKEN", c.host))
	case http.StatusForbidden:
		return exit.Configf(fmt.Errorf("turso: %s refused the auth token (HTTP 403); the token may not grant access to this database — run `tdo login` to mint one for it", c.host))
	case http.StatusNotFound:
		return exit.Providerf(fmt.Errorf("turso: %s has no database at %s (HTTP 404); check turso.url", c.host, pipelinePath))
	}
	if snippet == "" {
		return exit.Providerf(fmt.Errorf("turso: %s returned HTTP %d", c.host, resp.StatusCode))
	}
	return exit.Providerf(fmt.Errorf("turso: %s returned HTTP %d: %s", c.host, resp.StatusCode, snippet))
}

// readSnippet reads a bounded, sanitized piece of a failed response, so that
// an HTML error page from a proxy is reported as a short quoted string rather
// than pasted into the terminal.
func readSnippet(r io.Reader) string {
	raw, err := io.ReadAll(io.LimitReader(r, maxErrorBody))
	if err != nil || len(bytes.TrimSpace(raw)) == 0 {
		return ""
	}
	return clip(string(raw))
}

// remoteError carries a failed statement's report from the server. It exists
// so that the mapping in store.go can inspect the engine's text in one place
// and decide whether the user sees a sentinel instead.
type remoteError struct {
	host string
	err  *protoError
}

func (e *remoteError) Error() string {
	text := e.err.text()
	if text == "" {
		return fmt.Sprintf("turso: %s rejected the statement", e.host)
	}
	return fmt.Sprintf("turso: %s: %s", e.host, text)
}

// message returns the engine's text, for classification only.
func (e *remoteError) message() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Message + " " + e.err.Code
}
