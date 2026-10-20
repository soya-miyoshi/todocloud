package task

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

// The accessors are the only place the variance of JSON-sourced values is
// handled, so they are tested against every form a provider can hand back.
func TestFieldsInt(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  int
		ok    bool
	}{
		{"int", 3, 3, true},
		{"int64", int64(3), 3, true},
		{"float64 from encoding/json", float64(3), 3, true},
		{"json.Number", json.Number("3"), 3, true},
		{"string, as Firestore REST returns integers", "3", 3, true},
		{"non-numeric string", "high", 0, false},
		{"bool", true, 0, false},
		{"absent", nil, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := Fields{}
			if tc.value != nil {
				f["k"] = tc.value
			}
			got, ok := f.Int("k")
			if got != tc.want || ok != tc.ok {
				t.Errorf("Int() = (%d, %v), want (%d, %v)", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestFieldsStrings(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  []string
		ok    bool
	}{
		{"[]string", []string{"a", "b"}, []string{"a", "b"}, true},
		{"[]any", []any{"a", "b"}, []string{"a", "b"}, true},
		{"mixed []any is stringified", []any{"a", 2}, []string{"a", "2"}, true},
		{"a lone string is a one-element list", "a", []string{"a"}, true},
		{"empty string is an empty list", "", nil, true},
		{"number", 3, nil, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := Fields{"k": tc.value}
			got, ok := f.Strings("k")
			if ok != tc.ok || !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Strings() = (%#v, %v), want (%#v, %v)", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestFieldsBool(t *testing.T) {
	for _, tc := range []struct {
		value any
		want  bool
		ok    bool
	}{
		{true, true, true},
		{"true", true, true},
		{"false", false, true},
		{"yes", false, false},
		{1, false, false},
	} {
		f := Fields{"k": tc.value}
		got, ok := f.Bool("k")
		if got != tc.want || ok != tc.ok {
			t.Errorf("Bool(%#v) = (%v, %v), want (%v, %v)", tc.value, got, ok, tc.want, tc.ok)
		}
	}
}

func TestPriorityDefaultsToZero(t *testing.T) {
	if p := (Fields{}).Priority(); p != 0 {
		t.Errorf("Priority() = %d, want 0 when unset", p)
	}
	if p := (Fields{KeyPriority: "2"}).Priority(); p != 2 {
		t.Errorf("Priority() = %d, want 2: a provider may hand an integer back as a string", p)
	}
}

func TestNormalize(t *testing.T) {
	f := Fields{
		KeyPriority: json.Number("2"),
		KeyTags:     []any{"a", "b"},
		"estimate":  json.Number("5"),
		"ratio":     json.Number("0.25"),
		"whole":     float64(7),
		"nested":    map[string]any{"rounds": json.Number("2")},
		"list":      []any{json.Number("1"), "two"},
	}
	f.Normalize()

	want := Fields{
		KeyPriority: 2,
		"tags":      []any{"a", "b"},
		"estimate":  5,
		"ratio":     0.25,
		"whole":     7,
		"nested":    map[string]any{"rounds": 2},
		"list":      []any{1, "two"},
	}
	if !reflect.DeepEqual(f, want) {
		t.Errorf("Normalize()\n got: %#v\nwant: %#v", f, want)
	}
}

// A float64 holding exactly 2^63 is one past the end of int64's range, and
// float64 cannot represent MaxInt64 to say so: the untyped MaxInt64 constant
// rounds up to 2^63, so a <= bound lets the value through and the int
// conversion that follows is undefined by the Go spec — it saturates to
// MaxInt64 on arm64 and need not elsewhere. Either way the number the user
// stored is not the number that comes back, silently. It stays a float64.
func TestNormalizeLeavesValuesPastInt64AsFloats(t *testing.T) {
	justPastMax := math.Float64frombits(0x43E0000000000000) // exactly 2^63
	justPastMin := -justPastMax * 2                         // -2^64, well clear

	f := Fields{"high": justPastMax, "low": justPastMin, "min": float64(math.MinInt64)}
	f.Normalize()

	if v, ok := f["high"].(float64); !ok || v != justPastMax {
		t.Errorf("2^63 became %#v; it does not fit in an int64 and must stay a float", f["high"])
	}
	if v, ok := f["low"].(float64); !ok || v != justPastMin {
		t.Errorf("-2^64 became %#v; it must stay a float", f["low"])
	}
	// MinInt64 is exactly -2^63, which float64 represents exactly, so it is
	// in range and must still be intified.
	if v, ok := f["min"].(int); !ok || v != math.MinInt64 {
		t.Errorf("MinInt64 became %#v; it is representable and in range", f["min"])
	}
}

func TestParseValue(t *testing.T) {
	tests := []struct {
		in   string
		want any
	}{
		{"3", 3},
		{"0", 0},
		{"-2", -2},
		{"3.5", 3.5},
		{"5.0", 5},
		{"true", true},
		{"FALSE", false},
		{"null", nil},
		{"acme", "acme"},
		{"3.0.1", "3.0.1"},
		{"", ""},
		{`["a","b"]`, []any{"a", "b"}},
		{`{"owner":"me","rounds":2}`, map[string]any{"owner": "me", "rounds": 2}},
		{`{"broken":`, `{"broken":`},
		{"  spaced  ", "  spaced  "},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			if got := ParseValue(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseValue(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseDue(t *testing.T) {
	for _, in := range []string{"2026-11-01", "2026-11-01T10:00:00Z", "2026-11-01T10:00:00+09:00"} {
		if _, err := ParseDue(in); err != nil {
			t.Errorf("ParseDue(%q) = %v, want no error", in, err)
		}
	}
	for _, in := range []string{"", "next tuesday", "2026-13-01", "01/11/2026"} {
		if _, err := ParseDue(in); err == nil {
			t.Errorf("ParseDue(%q) = nil error, want a rejection", in)
		}
	}
}

func TestFormatAndParseTimeAreUTC(t *testing.T) {
	v, err := ParseTime("2026-11-01T10:00:00+09:00")
	if err != nil {
		t.Fatalf("ParseTime: %v", err)
	}
	if got := FormatTime(v); got != "2026-11-01T01:00:00Z" {
		t.Errorf("FormatTime() = %q, want the UTC form", got)
	}
	if _, err := ParseTime("2026-11-01"); err == nil {
		t.Error("ParseTime accepted a date-only value, want a rejection")
	}
}

func TestSetRemovesOnNil(t *testing.T) {
	f := Fields{"k": "v"}
	f.Set("k", nil)
	if _, ok := f["k"]; ok {
		t.Error("Set(key, nil) kept the key")
	}
}

func TestKeysAreSorted(t *testing.T) {
	f := Fields{"c": 1, "a": 2, "b": 3}
	if got := f.Keys(); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("Keys() = %v, want sorted", got)
	}
}
