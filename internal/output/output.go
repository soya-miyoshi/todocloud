// Package output renders everything the CLI prints.
//
// It exists to keep one rule in one place: machine output goes to stdout and
// everything else goes to stderr, so that `tdo ls --json | jq` is always safe.
// A Printer holds the two writers and whether --json was asked for; no command
// writes to a stream directly.
package output

import (
	"encoding/json"
	"fmt"
	"io"
)

// Printer writes a command's result.
type Printer struct {
	// Out receives machine output: JSON, CSV and the human-readable result of
	// a command. Nothing else may be written to it.
	Out io.Writer
	// Err receives warnings, hints, prompts and debug logging.
	Err io.Writer
	// JSON reports whether --json was given.
	JSON bool
	// Debug reports whether --debug was given. Debug output is held to the
	// same no-credentials standard as everything else.
	Debug bool
}

// Emit writes v to stdout as a single line of JSON. It is the only way a
// command produces --json output.
func (p Printer) Emit(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("render json: %w", err)
	}
	if _, err := p.Out.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

// Printf writes human-readable result text to stdout. Callers must not use it
// while p.JSON is set.
func (p Printer) Printf(format string, args ...any) {
	fmt.Fprintf(p.Out, format, args...)
}

// Warnf writes a warning to stderr.
func (p Printer) Warnf(format string, args ...any) {
	fmt.Fprintf(p.Err, "tdo: warning: "+format+"\n", args...)
}

// Hintf writes an advisory note to stderr. An empty listing, for instance, is
// not an error and must not put anything on stdout.
func (p Printer) Hintf(format string, args ...any) {
	fmt.Fprintf(p.Err, format+"\n", args...)
}

// Debugf writes a diagnostic to stderr when --debug is set. It must never be
// handed a config struct, a request header or a URL with a query string.
func (p Printer) Debugf(format string, args ...any) {
	if !p.Debug {
		return
	}
	fmt.Fprintf(p.Err, "tdo: debug: "+format+"\n", args...)
}

// errorEnvelope is the documented --json failure shape.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Fail reports err. Under --json the documented envelope goes to stdout, so a
// caller that parses stdout sees the failure in the same place as a success;
// otherwise the message goes to stderr prefixed with the program name.
func (p Printer) Fail(code string, err error) {
	if p.JSON {
		// A marshalling failure here would leave the caller with nothing on
		// stdout, so fall back to a hand-built envelope.
		if emitErr := p.Emit(errorEnvelope{Error: errorBody{Code: code, Message: err.Error()}}); emitErr != nil {
			fmt.Fprintf(p.Out, "{\"error\":{\"code\":%q,\"message\":\"\"}}\n", code)
		}
		return
	}
	fmt.Fprintf(p.Err, "tdo: %s\n", err.Error())
}
