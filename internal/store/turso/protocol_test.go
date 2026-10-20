package turso

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// An integer travels as a decimal string. The whole point of that is the
// int64 edges: a decoder that went through float64 would turn
// 9223372036854775807 into 9223372036854775808, and the project's rule is
// that any whole number fitting in an int64 is an int on both paths.
func TestIntegerValuesRoundTripAtTheInt64Edges(t *testing.T) {
	for _, n := range []int64{0, 1, -1, math.MaxInt64, math.MinInt64, 9007199254740993} {
		encoded, err := json.Marshal(value{Kind: kindInteger, Any: n})
		if err != nil {
			t.Fatalf("marshal %d: %v", n, err)
		}
		// The wire form is a string, not a JSON number.
		if !strings.Contains(string(encoded), `"value":"`) {
			t.Errorf("%d was sent as %s, want the decimal-string form", n, encoded)
		}
		var back value
		if err := json.Unmarshal(encoded, &back); err != nil {
			t.Fatalf("unmarshal %s: %v", encoded, err)
		}
		got, ok := back.Int64()
		if !ok || got != n {
			t.Errorf("%d round-tripped to %v (ok=%v)", n, back.Any, ok)
		}
	}
}

// A server that sends a bare JSON integer instead of the string form is
// still understood, and still not routed through a float.
func TestIntegerValueAcceptsABareJSONNumber(t *testing.T) {
	var v value
	if err := json.Unmarshal([]byte(`{"type":"integer","value":9223372036854775807}`), &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got, ok := v.Int64(); !ok || got != math.MaxInt64 {
		t.Errorf("got %v (ok=%v), want %d", v.Any, ok, int64(math.MaxInt64))
	}
}

func TestValueKindsRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		in   value
		want any
	}{
		{"null", value{Kind: kindNull}, nil},
		{"text", value{Kind: kindText, Any: "hello \u0000 world"}, "hello \u0000 world"},
		{"float", value{Kind: kindFloat, Any: 1.5}, 1.5},
		{"blob", value{Kind: kindBlob, Any: []byte{0, 1, 2, 255}}, []byte{0, 1, 2, 255}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var back value
			if err := json.Unmarshal(encoded, &back); err != nil {
				t.Fatalf("unmarshal %s: %v", encoded, err)
			}
			if tc.want == nil {
				if !back.IsNull() {
					t.Errorf("got %#v, want null", back)
				}
				return
			}
			if blob, ok := tc.want.([]byte); ok {
				got, _ := back.Any.([]byte)
				if string(got) != string(blob) {
					t.Errorf("got %v, want %v", got, blob)
				}
				return
			}
			if back.Any != tc.want {
				t.Errorf("got %#v, want %#v", back.Any, tc.want)
			}
		})
	}
}

// A malformed value is an error, never a silently empty column: a task whose
// title decoded to "" would look like a real task with no title.
func TestMalformedValuesAreRefused(t *testing.T) {
	for _, raw := range []string{
		`{"type":"integer","value":"not a number"}`,
		`{"type":"integer"}`,
		`{"type":"float","value":"nope"}`,
		`{"type":"text","value":7}`,
		`{"type":"blob","base64":"!!!!"}`,
		`{"type":"wat","value":"x"}`,
		`{"value":"x"}`,
		`"bare string"`,
		`7`,
	} {
		var v value
		if err := json.Unmarshal([]byte(raw), &v); err == nil {
			t.Errorf("unmarshal(%s) succeeded as %#v, want an error", raw, v)
		}
	}
}

// Binding only accepts the types this package actually sends, so a new call
// site that passes something else fails loudly instead of sending a surprise.
func TestEncodeArgRejectsUnknownTypes(t *testing.T) {
	if _, err := encodeArg(struct{ A int }{1}); err == nil {
		t.Error("encodeArg accepted a struct, want an error")
	}
	if _, err := newStatement("SELECT 1", true, map[string]string{}); err == nil {
		t.Error("newStatement accepted a map argument, want an error")
	}
}

// A whole float binds as an integer, which is the same rule
// task.Fields.Normalize applies, so a value has one type on both sides of a
// round trip.
func TestEncodeArgIntifiesWholeFloats(t *testing.T) {
	v, err := encodeArg(3.0)
	if err != nil {
		t.Fatalf("encodeArg: %v", err)
	}
	if v.Kind != kindInteger {
		t.Errorf("3.0 bound as %q, want %q", v.Kind, kindInteger)
	}
	if v, err := encodeArg(3.5); err != nil || v.Kind != kindFloat {
		t.Errorf("3.5 bound as %q (%v), want %q", v.Kind, err, kindFloat)
	}
}

// The endpoint is derived, never configured. libsql:// is https://, and a URL
// that would carry a credential is refused outright.
func TestEndpointFor(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"libsql becomes https", exampleURL, "https://example.turso.io/v2/pipeline"},
		{"https is accepted as given", "https://example.turso.io", "https://example.turso.io/v2/pipeline"},
		{"http reaches a self-hosted sqld", "http://127.0.0.1:8080", "http://127.0.0.1:8080/v2/pipeline"},
		{"a trailing slash is not doubled", "libsql://example.turso.io/", "https://example.turso.io/v2/pipeline"},
		{"surrounding whitespace is ignored", "  " + exampleURL + "\n", "https://example.turso.io/v2/pipeline"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, _, err := endpointFor(tc.in)
			if err != nil {
				t.Fatalf("endpointFor(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("endpointFor(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestEndpointForRefusesURLsThatCouldCarryACredential(t *testing.T) {
	tests := []struct {
		name string
		in   string
	}{
		{"empty", ""},
		{"no scheme", "example.turso.io"},
		{"unsupported scheme", "ftp://example.turso.io"},
		{"no host", "libsql://"},
		{"userinfo", "libsql://user:TOKEN_GOES_HERE@example.turso.io"},
		{"query string", "libsql://example.turso.io?authToken=TOKEN_GOES_HERE"},
		{"empty query string", "libsql://example.turso.io?"},
		{"fragment", "libsql://example.turso.io#TOKEN_GOES_HERE"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			endpoint, _, err := endpointFor(tc.in)
			if err == nil {
				t.Fatalf("endpointFor(%q) = %q, want an error", tc.in, endpoint)
			}
			// The refusal explains the problem without echoing the value
			// that might have been a token.
			if strings.Contains(err.Error(), testToken) {
				t.Errorf("the refusal quotes the credential: %v", err)
			}
		})
	}
}

// clip is what bounds untrusted server text on its way into an error. It must
// shorten, strip control characters and quote.
func TestClipBoundsUntrustedText(t *testing.T) {
	got := clip(strings.Repeat("x", 500))
	if len(got) > 140 {
		t.Errorf("clip returned %d bytes, want it bounded", len(got))
	}
	if strings.Contains(clip("a\x00b\nc"), "\x00") {
		t.Error("clip kept a NUL")
	}
}
