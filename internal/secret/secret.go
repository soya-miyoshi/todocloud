// Package secret holds credential values in a type that cannot be printed.
//
// Every token the CLI handles is a Secret. The zero value is an absent secret.
// String, Format, MarshalJSON and LogValue all return the redaction marker, so
// a secret that reaches a log line, an error message or --json output by
// accident is still not disclosed. The only way to obtain the underlying value
// is Reveal, which is deliberately verbose at the call site.
package secret

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

// Redacted is what a Secret renders as in every output path.
const Redacted = "[REDACTED]"

// Secret wraps a credential. Pass it by value; it is immutable.
type Secret struct {
	value string
}

// New returns a Secret holding value.
func New(value string) Secret {
	return Secret{value: value}
}

// Reveal returns the underlying credential. Call it only where the value is
// about to be handed to the provider, never to build a message for a human.
func (s Secret) Reveal() string {
	return s.value
}

// Empty reports whether no credential is set.
func (s Secret) Empty() bool {
	return s.value == ""
}

// Hint tells one configured credential apart from another without disclosing
// any part of either: the empty string when unset, otherwise the redaction
// marker and a short fingerprint, `[REDACTED]#1a2b3c4d`.
//
// The question Hint exists to answer is "did tdo pick up the token I just
// rotated?", which `token_present: true` cannot answer. An earlier version
// answered it with the last four characters of the value. That was a poor
// trade: four characters are useless to an attacker but they are still four
// real characters of a credential, landing wherever `tdo config` output
// lands — a scrollback, a screenshot, an issue — and the docs promise that
// this output is safe to paste. A fingerprint keeps the promise true.
//
// It is a plain hash rather than a keyed one so that two origins of the same
// token (the environment and the keychain, say) fingerprint alike and can be
// compared in one glance. That makes it an offline verifier: someone holding
// the fingerprint could confirm a guess at the secret. For the provider
// tokens this tool handles — high-entropy values nobody guesses — that is
// not a real attack, and it is strictly less disclosure than printing part
// of the value. Eight hex digits is plenty to notice a change and far too
// few to be mistaken for the credential itself.
func (s Secret) Hint() string {
	if s.value == "" {
		return ""
	}
	// The domain separator keeps these fingerprints from matching a bare
	// SHA-256 of the same token computed somewhere else.
	sum := sha256.Sum256([]byte("todocloud/secret-fingerprint/v1\x00" + s.value))
	return Redacted + "#" + hex.EncodeToString(sum[:4])
}

// String implements fmt.Stringer.
func (s Secret) String() string { return Redacted }

// GoString implements fmt.GoStringer, so %#v on a struct holding a Secret does
// not expose it either.
func (s Secret) GoString() string { return Redacted }

// Format implements fmt.Formatter for every verb, including %q and %v, so no
// format string can reach the underlying value.
func (s Secret) Format(f fmt.State, verb rune) {
	switch verb {
	case 'q':
		fmt.Fprintf(f, "%q", Redacted)
	default:
		fmt.Fprint(f, Redacted)
	}
}

// MarshalJSON implements json.Marshaler.
func (s Secret) MarshalJSON() ([]byte, error) {
	return json.Marshal(Redacted)
}

// UnmarshalJSON implements json.Unmarshaler, so a secret read out of a JSON
// credential file keeps its protection. The redaction marker is treated as an
// absent value, which makes a redacted document safe to feed back in.
func (s *Secret) UnmarshalJSON(data []byte) error {
	var v string
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	if v == Redacted || strings.HasPrefix(v, Redacted+"…") {
		s.value = ""
		return nil
	}
	s.value = v
	return nil
}

// LogValue implements slog.LogValuer.
func (s Secret) LogValue() slog.Value {
	return slog.StringValue(Redacted)
}
