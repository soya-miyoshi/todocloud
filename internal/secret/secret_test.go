package secret

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

const token = "TOKEN_GOES_HERE_0123456789"

func TestSecretNeverRendersItsValue(t *testing.T) {
	s := New(token)

	// Every path a credential could plausibly escape through.
	rendered := []string{
		s.String(),
		s.GoString(),
		s.Hint(),
		fmt.Sprint(s),
		fmt.Sprintf("%v", s),
		fmt.Sprintf("%+v", s),
		fmt.Sprintf("%#v", s),
		fmt.Sprintf("%s", s),
		fmt.Sprintf("%q", s),
		fmt.Sprintf("%v", struct{ Token Secret }{s}),
		fmt.Sprintf("%+v", struct{ Token Secret }{s}),
		fmt.Sprintf("%#v", struct{ Token Secret }{s}),
		fmt.Sprintf("%v", []Secret{s}),
		fmt.Sprintf("%v", map[string]Secret{"token": s}),
	}

	data, err := json.Marshal(struct {
		Token Secret `json:"token"`
	}{s})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	rendered = append(rendered, string(data))

	var logged bytes.Buffer
	slog.New(slog.NewTextHandler(&logged, nil)).Info("configured", "token", s)
	rendered = append(rendered, logged.String())

	for _, got := range rendered {
		if strings.Contains(got, token) {
			t.Errorf("secret value leaked into %q", got)
		}
	}
}

func TestReveal(t *testing.T) {
	if got := New(token).Reveal(); got != token {
		t.Errorf("Reveal() = %q, want the stored value", got)
	}
}

func TestEmpty(t *testing.T) {
	if !New("").Empty() {
		t.Error(`New("").Empty() = false, want true`)
	}
	if New(token).Empty() {
		t.Error("New(token).Empty() = true, want false")
	}
}

// Hint has to distinguish two credentials without disclosing a character of
// either, because `tdo config` output is documented as safe to paste.
func TestHint(t *testing.T) {
	if got := New("").Hint(); got != "" {
		t.Errorf("an unset secret hints %q, want the empty string", got)
	}

	// Whatever it prints, no run of the secret may appear in it. Four
	// characters was the old behaviour and is what this guards against
	// coming back.
	hint := New(token).Hint()
	for n := 3; n <= len(token); n++ {
		for i := 0; i+n <= len(token); i++ {
			if run := token[i : i+n]; strings.Contains(hint, run) {
				t.Fatalf("the hint %q contains %q, a run of the secret", hint, run)
			}
		}
	}
	if !strings.HasPrefix(hint, Redacted) {
		t.Errorf("the hint %q does not start with the redaction marker", hint)
	}

	// Same secret, same fingerprint: that is what makes "did tdo pick up
	// the token I rotated?" answerable, and what lets two origins of one
	// token be compared.
	if other := New(token).Hint(); other != hint {
		t.Errorf("the same secret hinted %q and %q", hint, other)
	}
	// Different secrets, different fingerprints — including two that differ
	// only in the tail the old implementation would have shown.
	for _, different := range []string{
		token + "x",
		"TOKEN_GOES_HERE_9876543210",
		strings.TrimSuffix(token, "9") + "8",
		"short",
	} {
		if New(different).Hint() == hint {
			t.Errorf("%q and a different secret share the hint %q", different, hint)
		}
	}

	// A short secret is fingerprinted like any other: the old rule gave
	// short values no suffix, which leaked the fact that they were short.
	if got := New("abc").Hint(); got == Redacted || !strings.HasPrefix(got, Redacted+"#") {
		t.Errorf("a short secret hints %q; its length must not change the shape", got)
	}
}

func TestUnmarshalJSON(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain value", `"` + token + `"`, token},
		{"redaction marker becomes absent", `"` + Redacted + `"`, ""},
		{"hint becomes absent", `"` + Redacted + `…6789"`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var s Secret
			if err := json.Unmarshal([]byte(tc.in), &s); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if got := s.Reveal(); got != tc.want {
				t.Errorf("Reveal() = %q, want %q", got, tc.want)
			}
		})
	}
}

// A redacted document must be safe to feed back in without resurrecting a
// value or carrying the marker into a provider request.
func TestRoundTripThroughJSONDoesNotKeepTheValue(t *testing.T) {
	data, err := json.Marshal(New(token))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var back Secret
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !back.Empty() {
		t.Errorf("round trip produced %q, want an absent secret", back.Reveal())
	}
}
