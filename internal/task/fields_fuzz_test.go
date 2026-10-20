package task

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// ParseValue reads whatever an agent or a user typed after `--set key=`, so it
// is the widest untrusted surface in the command layer. Two invariants matter:
// the result is always one of the JSON-shaped Go types the rest of the CLI
// knows how to store, and storing it has to be lossless, which means it must
// survive a JSON round trip followed by Normalize.
func FuzzParseValue(f *testing.F) {
	seeds := []string{
		"", " ", "\t\n",
		"true", "false", "TRUE", "False", "null", "NULL",
		"0", "-1", "42", "007",
		"3.5", "-0.0", "1e3", "1e400", "5.0",
		"9223372036854775807", "99999999999999999999",
		"NaN", "Inf", "+Inf", "-Inf",
		"9999999999999999.0000", "1e21", "-9007199254740993.0",
		"3.0.1", "2026-11-01", "acme",
		`["a","b"]`, "[1,2,3]", "[]", "[", "[1,", `[{"a":1}]`,
		`{"owner":"a","k":1}`, "{}", "{", `{"a":`,
		`{"a":{"b":{"c":[1,2,{"d":3.5}]}}}`,
		`"quoted"`,
		"'; DROP TABLE tasks; --",
		"%s", "{{.}}", "../../etc/passwd",
		"a\x00b", "\xff\xfe",
		"\x1b[31mred\x1b[0m",
		strings.Repeat("A", 10000),
		"  padded  ",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, raw string) {
		v := ParseValue(raw)
		assertJSONShape(t, v)

		if !utf8Clean(v) {
			// encoding/json replaces an invalid UTF-8 byte with U+FFFD, so
			// such a value is lossy by construction; see
			// TestParseValueKeepsInvalidUTF8ThatJSONWouldReplace.
			return
		}
		if !jsonEncodable(v) {
			// json.Marshal refuses NaN and the infinities; see
			// TestParseValueAcceptsNaNWhichCannotBeStored, which pins the
			// current behaviour of that input.
			return
		}

		before := Fields{"v": v}
		before.Normalize()
		encoded, err := json.Marshal(map[string]any(before))
		if err != nil {
			t.Fatalf("ParseValue(%q) = %#v, which cannot be encoded: %v", raw, v, err)
		}
		dec := json.NewDecoder(strings.NewReader(string(encoded)))
		dec.UseNumber()
		var decoded map[string]any
		if err := dec.Decode(&decoded); err != nil {
			t.Fatalf("decode %s: %v", encoded, err)
		}
		after := Fields(decoded)
		after.Normalize()
		// The property that matters for `tdo export | tdo import` is that the
		// encoding is stable, not that the Go type is: Normalize declines to
		// turn a whole float of 2^53 or more into an int while the decoder
		// does, so the two differ in type while encoding identically. See
		// TestNormalizeDisagreesWithTheDecoderOnLargeWholeFloats.
		reencoded, err := json.Marshal(map[string]any(after))
		if err != nil {
			t.Fatalf("re-encode %#v: %v", after["v"], err)
		}
		if string(reencoded) != string(encoded) {
			t.Fatalf("ParseValue(%q) does not survive a JSON round trip: %s -> %s", raw, encoded, reencoded)
		}
		if _, ok := before["v"].(float64); !ok {
			if !reflect.DeepEqual(map[string]any(before), map[string]any(after)) {
				t.Fatalf("ParseValue(%q) changed shape over a JSON round trip: %#v -> %#v", raw, before["v"], after["v"])
			}
		}
	})
}

// assertJSONShape fails unless v is one of the Go types the model stores.
func assertJSONShape(t *testing.T, v any) {
	t.Helper()
	switch typed := v.(type) {
	case nil, bool, int, float64, string:
	case []any:
		for _, e := range typed {
			assertJSONShape(t, e)
		}
	case map[string]any:
		for _, e := range typed {
			assertJSONShape(t, e)
		}
	default:
		t.Fatalf("ParseValue produced %T, which is not a storable JSON type", v)
	}
}

// jsonEncodable reports whether v holds a float that encoding/json refuses.
func jsonEncodable(v any) bool {
	switch typed := v.(type) {
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case []any:
		for _, e := range typed {
			if !jsonEncodable(e) {
				return false
			}
		}
	case map[string]any:
		for _, e := range typed {
			if !jsonEncodable(e) {
				return false
			}
		}
	}
	return true
}

// utf8Clean reports whether every string in v is valid UTF-8.
func utf8Clean(v any) bool {
	switch typed := v.(type) {
	case string:
		return utf8.ValidString(typed)
	case []any:
		for _, e := range typed {
			if !utf8Clean(e) {
				return false
			}
		}
	case map[string]any:
		for k, e := range typed {
			if !utf8.ValidString(k) || !utf8Clean(e) {
				return false
			}
		}
	}
	return true
}

// A value holding bytes that are not UTF-8 is kept as typed, but encoding/json
// substitutes U+FFFD for them, so it is not what comes back out of a store or
// out of --json. Pinned rather than endorsed.
func TestParseValueKeepsInvalidUTF8ThatJSONWouldReplace(t *testing.T) {
	const raw = "bad \xff\xfe bytes"
	v := ParseValue(raw)
	if v != raw {
		t.Fatalf("ParseValue(%q) = %#v, want the string unchanged", raw, v)
	}
	encoded, err := json.Marshal(Fields{"v": v})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(encoded, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back["v"] == raw {
		t.Fatal("encoding/json preserved the invalid bytes; the round trip is no longer lossy")
	}
	if !utf8.ValidString(back["v"].(string)) {
		t.Fatalf("expected the replacement character, got %q", back["v"])
	}
}

// Normalize keeps a whole float of 2^53 or more as a float64, but the decoder
// that reads a stored field back runs json.Number.Int64 with no such guard, so
// / A whole number is stored as an int whether it came from the command line or
// from a provider, and a value too large for that stays a float64 on both
// paths. Normalize's purpose is that a task read back compares equal to one
// built in memory, so the two paths have to use the same range guard.
func TestNormalizeAgreesWithTheDecoderOnLargeWholeFloats(t *testing.T) {
	for _, tc := range []struct {
		raw      string
		wantKind string
	}{
		{"9999999999999999.0000", "int"}, // whole, and inside int64's range
		{"5.0", "int"},
		{"9007199254740992", "int"},    // 2^53, still an integer
		{"9223372036854775807", "int"}, // the largest int64
		{"1e30", "float64"},            // whole, but beyond int64
		{"3.5", "float64"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			v := ParseValue(tc.raw)
			if got := kindOf(v); got != tc.wantKind {
				t.Fatalf("ParseValue(%q) = %#v (%s), want %s", tc.raw, v, got, tc.wantKind)
			}

			encoded, err := json.Marshal(Fields{"v": v})
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			dec := json.NewDecoder(strings.NewReader(string(encoded)))
			dec.UseNumber()
			var back map[string]any
			if err := dec.Decode(&back); err != nil {
				t.Fatalf("decode: %v", err)
			}
			f := Fields(back)
			f.Normalize()

			if got := kindOf(f["v"]); got != tc.wantKind {
				t.Errorf("after a store round trip the value is %#v (%s), want %s", f["v"], got, tc.wantKind)
			}
		})
	}
}

func kindOf(v any) string {
	switch v.(type) {
	case int:
		return "int"
	case float64:
		return "float64"
	default:
		return fmt.Sprintf("%T", v)
	}
}

// NaN and the infinities are the one class of value a float parser accepts and
// JSON cannot represent. ParseValue keeps them as strings, so `--set n=NaN`
// stores the text the user typed instead of a value that fails on the way out.
func TestParseValueKeepsNonFiniteNumbersAsText(t *testing.T) {
	for _, raw := range []string{"NaN", "nan", "Inf", "+Inf", "-inf", "infinity"} {
		v := ParseValue(raw)
		got, ok := v.(string)
		if !ok {
			t.Fatalf("ParseValue(%q) = %#v (%T), want the text unchanged", raw, v, v)
		}
		if got != raw {
			t.Errorf("ParseValue(%q) = %q, want it unchanged", raw, got)
		}
		if _, err := json.Marshal(Fields{"v": v}); err != nil {
			t.Errorf("the stored form of %q cannot be marshalled: %v", raw, err)
		}
	}
}
