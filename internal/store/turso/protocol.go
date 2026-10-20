package turso

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The libSQL remote protocol types every value that crosses the wire, in both
// directions:
//
//	{"type":"null"}
//	{"type":"integer","value":"9223372036854775807"}
//	{"type":"float","value":1.5}
//	{"type":"text","value":"hello"}
//	{"type":"blob","base64":"aGk"}
//
// An integer travels as a *decimal string* because JSON numbers are doubles
// in most readers, and this project stores int64 values (see
// task.Fields.Normalize, which intifies every whole number that fits in an
// int64). Decoding an integer through float64 would silently round
// 9223372036854775807 to 9223372036854775808, so the string form is parsed
// with strconv and never touches a float.
const (
	kindNull    = "null"
	kindInteger = "integer"
	kindFloat   = "float"
	kindText    = "text"
	kindBlob    = "blob"
)

// value is one typed protocol value. Any holds the decoded Go form: nil,
// int64, float64, string or []byte, matching Kind.
type value struct {
	Kind string
	Any  any
}

// wireValue is the on-the-wire shape. Value is left raw so that an integer can
// be read from either a string (what the protocol specifies) or a bare JSON
// number (what a lenient server might send) without going through float64.
type wireValue struct {
	Type   string          `json:"type"`
	Value  json.RawMessage `json:"value,omitempty"`
	Base64 string          `json:"base64,omitempty"`
}

// MarshalJSON renders a bound argument.
func (v value) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case kindNull:
		return json.Marshal(wireValue{Type: kindNull})
	case kindInteger:
		n, _ := v.Any.(int64)
		return json.Marshal(wireValue{Type: kindInteger, Value: json.RawMessage(strconv.Quote(strconv.FormatInt(n, 10)))})
	case kindFloat:
		f, _ := v.Any.(float64)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			// JSON cannot carry these, and nothing in the data model
			// produces one: Fields.ParseValue refuses them on the way in.
			return nil, fmt.Errorf("turso: cannot send %v as a float value", f)
		}
		b, err := json.Marshal(f)
		if err != nil {
			return nil, err
		}
		return json.Marshal(wireValue{Type: kindFloat, Value: b})
	case kindText:
		s, _ := v.Any.(string)
		b, err := json.Marshal(s)
		if err != nil {
			return nil, err
		}
		return json.Marshal(wireValue{Type: kindText, Value: b})
	case kindBlob:
		raw, _ := v.Any.([]byte)
		return json.Marshal(wireValue{Type: kindBlob, Base64: base64.RawStdEncoding.EncodeToString(raw)})
	default:
		return nil, fmt.Errorf("turso: unknown value kind %q", v.Kind)
	}
}

// UnmarshalJSON reads a returned value. Every malformed shape is an error
// rather than a zero value, because a column silently read as "" would show
// up as a task with no title rather than as a failed command.
func (v *value) UnmarshalJSON(data []byte) error {
	var w wireValue
	if err := json.Unmarshal(data, &w); err != nil {
		return fmt.Errorf("turso: malformed value: %w", err)
	}
	switch w.Type {
	case kindNull:
		*v = value{Kind: kindNull}
		return nil
	case kindInteger:
		n, err := decodeInteger(w.Value)
		if err != nil {
			return err
		}
		*v = value{Kind: kindInteger, Any: n}
		return nil
	case kindFloat:
		f, err := decodeFloat(w.Value)
		if err != nil {
			return err
		}
		*v = value{Kind: kindFloat, Any: f}
		return nil
	case kindText:
		var s string
		if err := json.Unmarshal(w.Value, &s); err != nil {
			return fmt.Errorf("turso: malformed text value: %w", err)
		}
		*v = value{Kind: kindText, Any: s}
		return nil
	case kindBlob:
		raw, err := decodeBase64(w.Base64)
		if err != nil {
			return err
		}
		*v = value{Kind: kindBlob, Any: raw}
		return nil
	case "":
		return fmt.Errorf("turso: value has no type")
	default:
		return fmt.Errorf("turso: unknown value type %q", w.Type)
	}
}

// decodeInteger reads the decimal string the protocol specifies, and tolerates
// a bare JSON integer. Neither path goes through float64, so the whole int64
// range survives.
func decodeInteger(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 {
		return 0, fmt.Errorf("turso: integer value has no value")
	}
	s := string(raw)
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, fmt.Errorf("turso: malformed integer value: %w", err)
		}
		s = text
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("turso: malformed integer value %s", clip(string(raw)))
	}
	return n, nil
}

// decodeFloat accepts a JSON number, and a string for symmetry with integers.
func decodeFloat(raw json.RawMessage) (float64, error) {
	if len(raw) == 0 {
		return 0, fmt.Errorf("turso: float value has no value")
	}
	s := string(raw)
	if raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, fmt.Errorf("turso: malformed float value: %w", err)
		}
		s = text
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("turso: malformed float value %s", clip(string(raw)))
	}
	return f, nil
}

// decodeBase64 accepts the padded and unpadded alphabets, since servers differ
// on which they emit.
func decodeBase64(s string) ([]byte, error) {
	if s == "" {
		return []byte{}, nil
	}
	if raw, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "=")); err == nil {
		return raw, nil
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("turso: malformed blob value")
	}
	return raw, nil
}

// IsNull reports whether the column was SQL NULL.
func (v value) IsNull() bool { return v.Kind == kindNull || v.Any == nil }

// Text renders the value as the Go string this package stores it as. An
// integer or a float read back from a text column is rendered rather than
// refused, because SQLite's typing is per value: a column declared TEXT can
// hold an integer if something else wrote one there.
func (v value) Text() (string, bool) {
	switch t := v.Any.(type) {
	case string:
		return t, true
	case int64:
		return strconv.FormatInt(t, 10), true
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64), true
	case []byte:
		return string(t), true
	default:
		return "", false
	}
}

// Int64 reads the value as an integer, accepting the text and whole-float
// spellings for the same reason Text is tolerant.
func (v value) Int64() (int64, bool) {
	switch t := v.Any.(type) {
	case int64:
		return t, true
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		return n, err == nil
	case float64:
		if t != math.Trunc(t) || t < math.MinInt64 || t > math.MaxInt64 {
			return 0, false
		}
		return int64(t), true
	default:
		return 0, false
	}
}

// encodeArg converts a Go value into a bound argument. Only the types this
// package actually binds are accepted; anything else is a programming error
// caught at the call site rather than sent as a surprise.
func encodeArg(v any) (value, error) {
	switch t := v.(type) {
	case nil:
		return value{Kind: kindNull}, nil
	case string:
		return value{Kind: kindText, Any: t}, nil
	case []byte:
		return value{Kind: kindBlob, Any: t}, nil
	case bool:
		var n int64
		if t {
			n = 1
		}
		return value{Kind: kindInteger, Any: n}, nil
	case int:
		return value{Kind: kindInteger, Any: int64(t)}, nil
	case int64:
		return value{Kind: kindInteger, Any: t}, nil
	case float64:
		// The same rule Fields.Normalize applies: a whole number that fits in
		// an int64 is an integer on both paths, so a value has the same type
		// before and after a store round trip.
		if t == math.Trunc(t) && t >= math.MinInt64 && t <= math.MaxInt64 {
			return value{Kind: kindInteger, Any: int64(t)}, nil
		}
		return value{Kind: kindFloat, Any: t}, nil
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return value{Kind: kindInteger, Any: n}, nil
		}
		f, err := t.Float64()
		if err != nil {
			return value{}, fmt.Errorf("turso: cannot bind number %s", clip(t.String()))
		}
		return value{Kind: kindFloat, Any: f}, nil
	default:
		return value{}, fmt.Errorf("turso: cannot bind a value of type %T", v)
	}
}

// statement is one SQL statement with its positional arguments.
type statement struct {
	SQL      string  `json:"sql"`
	Args     []value `json:"args"`
	WantRows bool    `json:"want_rows"`
}

// newStatement binds args to sql. wantRows asks the server for the result
// rows; a write asks for none, which keeps the response small.
func newStatement(sql string, wantRows bool, args ...any) (statement, error) {
	st := statement{SQL: sql, Args: make([]value, 0, len(args)), WantRows: wantRows}
	for i, a := range args {
		v, err := encodeArg(a)
		if err != nil {
			return statement{}, fmt.Errorf("argument %d: %w", i+1, err)
		}
		st.Args = append(st.Args, v)
	}
	return st, nil
}

// pipelineRequest is the body of POST /v2/pipeline.
type pipelineRequest struct {
	Requests []streamRequest `json:"requests"`
}

type streamRequest struct {
	Type string     `json:"type"`
	Stmt *statement `json:"stmt,omitempty"`
}

// pipelineResponse is the body that comes back. Results are positional: one
// per request, in order.
type pipelineResponse struct {
	Baton   string          `json:"baton"`
	Results []streamResult  `json:"results"`
	Error   json.RawMessage `json:"error"`
}

type streamResult struct {
	Type     string          `json:"type"`
	Response *streamResponse `json:"response"`
	Error    *protoError     `json:"error"`
}

type streamResponse struct {
	Type   string         `json:"type"`
	Result *executeResult `json:"result"`
}

// executeResult is one statement's outcome.
type executeResult struct {
	Cols             []column  `json:"cols"`
	Rows             [][]value `json:"rows"`
	AffectedRowCount int64     `json:"affected_row_count"`
}

type column struct {
	Name *string `json:"name"`
}

// protoError is the server's report of a failed statement. Its Message is the
// remote SQLite engine's text: it is classified here and, for every class the
// CLI has a sentinel for, replaced rather than passed on.
type protoError struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

func (e *protoError) text() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// clip shortens and sanitizes untrusted text before it reaches an error
// message, so a server that answers with a megabyte of HTML does not print a
// megabyte of HTML.
func clip(s string) string {
	const max = 120
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > max {
		return strconv.Quote(s[:max]) + "…"
	}
	return strconv.Quote(s)
}
