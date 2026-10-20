package task

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Fields holds the user-defined part of a task.
//
// Its values come from JSON, so a number may arrive as float64, as json.Number
// or as an int set by this process. The accessors below are the only place that
// variance is handled: nothing outside this package should type-assert a field
// value, which keeps `any` out of the command layer.
type Fields map[string]any

// Clone returns a deep copy.
func (f Fields) Clone() Fields {
	out := make(Fields, len(f))
	for k, v := range f {
		out[k] = cloneValue(v)
	}
	return out
}

func cloneValue(v any) any {
	switch t := v.(type) {
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = cloneValue(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = cloneValue(e)
		}
		return out
	default:
		return v
	}
}

// Keys returns the field names, sorted, so output is deterministic.
func (f Fields) Keys() []string {
	keys := make([]string, 0, len(f))
	for k := range f {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Set stores a value, removing the key when value is nil.
func (f Fields) Set(key string, value any) {
	if value == nil {
		delete(f, key)
		return
	}
	f[key] = value
}

// Delete removes a key.
func (f Fields) Delete(key string) { delete(f, key) }

// String returns a string field. It reports false when the key is absent or
// holds a non-string.
func (f Fields) String(key string) (string, bool) {
	v, ok := f[key].(string)
	return v, ok
}

// Int returns an integer field, accepting every numeric form JSON can produce.
func (f Fields) Int(key string) (int, bool) {
	switch v := f[key].(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		return int(n), err == nil
	case string:
		// Firestore returns integers as strings over REST.
		n, err := strconv.Atoi(v)
		return n, err == nil
	default:
		return 0, false
	}
}

// Bool returns a boolean field.
func (f Fields) Bool(key string) (bool, bool) {
	switch v := f[key].(type) {
	case bool:
		return v, true
	case string:
		b, err := strconv.ParseBool(v)
		return b, err == nil
	default:
		return false, false
	}
}

// Strings returns a string-list field. A single string is treated as a
// one-element list, because that is what a hand-edited document often holds.
func (f Fields) Strings(key string) ([]string, bool) {
	switch v := f[key].(type) {
	case []string:
		return v, true
	case string:
		if v == "" {
			return nil, true
		}
		return []string{v}, true
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			s, ok := e.(string)
			if !ok {
				s = fmt.Sprint(e)
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}

// Normalize converts values into the canonical Go forms this package stores,
// so a task read from a provider compares equal to one built in memory. JSON
// numbers become int where they are whole and float64 otherwise, including
// inside nested arrays and objects, which is what makes an unknown
// user-defined field survive a round trip unchanged.
func (f Fields) Normalize() {
	for k, v := range f {
		switch k {
		case KeyPriority:
			if n, ok := f.Int(k); ok {
				f[k] = n
			}
		default:
			f[k] = normalizeValue(v)
		}
	}
}

// maxInt64Exclusive is 2^63 as a float64: the first value above int64's
// range. It is exact, because a power of two always is.
const maxInt64Exclusive = float64(1 << 63)

func normalizeValue(v any) any {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return int(i)
		}
		if fl, err := t.Float64(); err == nil && !math.IsNaN(fl) && !math.IsInf(fl, 0) {
			return fl
		}
		return t.String()
	case float64:
		// A whole number is an int as far as this CLI is concerned; nothing in
		// the model needs a float that happens to be integral.
		//
		// The bound is int64's range rather than 2^53, because JSON cannot
		// tell a float that is whole from an integer: `1e16` is written
		// `10000000000000000`, and a decoder reading that back has no way to
		// know which it was. Intifying everything that fits is the only rule
		// under which a value has the same Go type before and after a store
		// round trip, which is what Normalize exists to guarantee.
		//
		// The upper bound is strict against 2^63 rather than <= MaxInt64:
		// float64 cannot represent MaxInt64, so the untyped constant rounds
		// up to 2^63 and a value one past the end of the range would pass.
		// The conversion that followed is undefined by the Go spec — it
		// saturates on arm64 and need not elsewhere — so the number came
		// back silently changed. MinInt64 is exactly -2^63 and representable,
		// so the lower bound is inclusive and correct as written.
		if t == math.Trunc(t) && t >= math.MinInt64 && t < maxInt64Exclusive {
			return int(t)
		}
		return t
	case []any:
		for i, e := range t {
			t[i] = normalizeValue(e)
		}
		return t
	case map[string]any:
		for k, e := range t {
			t[k] = normalizeValue(e)
		}
		return t
	default:
		return v
	}
}

// Priority returns the priority field, 0 when unset.
func (f Fields) Priority() int {
	p, _ := f.Int(KeyPriority)
	return p
}

// ParseValue converts a `key=value` command-line value into the most specific
// JSON type it clearly is: a bool, an integer, a float, a JSON array or object
// when it parses as one, and otherwise a string. This is what `--set` uses, so
// `--set estimate=3` stores a number while `--set ref=3.0.1` stores a string.
func ParseValue(raw string) any {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	switch strings.ToLower(s) {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	if fl, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(fl) && !math.IsInf(fl, 0) {
		// normalizeValue decides int vs float, so `--set n=5.0` and a stored
		// 5 end up as the same Go value. NaN and the infinities are excluded
		// deliberately: JSON cannot represent them, so accepting one here
		// would store a value that fails on the way out instead of a string
		// that round-trips.
		return normalizeValue(fl)
	}
	if s[0] == '[' || s[0] == '{' {
		var v any
		dec := json.NewDecoder(strings.NewReader(s))
		dec.UseNumber()
		if err := dec.Decode(&v); err == nil {
			normalized := Fields{"v": v}
			normalized.Normalize()
			return normalized["v"]
		}
	}
	return raw
}

// TimeFormat is the wire format for every timestamp the CLI writes.
const TimeFormat = time.RFC3339

// FormatTime renders t in UTC in the wire format.
func FormatTime(t time.Time) string {
	return t.UTC().Format(TimeFormat)
}

// ParseTime reads a timestamp written by FormatTime, accepting the sub-second
// variants a provider may hand back.
func ParseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timestamp %q: expected RFC 3339", s)
	}
	return t.UTC(), nil
}

// DueDateFormat is the date-only form accepted for the due field.
const DueDateFormat = "2006-01-02"

// ParseDue accepts either a plain date or a full RFC 3339 timestamp and
// returns the instant it refers to. A plain date means the end of that day in
// UTC, so `--due-before 2026-11-01` does not drop tasks due on the first.
func ParseDue(s string) (time.Time, error) {
	if d, err := time.Parse(DueDateFormat, s); err == nil {
		return d.UTC(), nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("invalid due date %q: expected YYYY-MM-DD or RFC 3339", s)
}
