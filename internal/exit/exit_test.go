package exit

import (
	"errors"
	"fmt"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		wantCode int
		wantJSON string
	}{
		{"no error", nil, OK, ""},
		{"plain error", errors.New("boom"), Error, CodeError},
		{"not found", store.ErrNotFound, NotFound, CodeNotFound},
		{"ambiguous", store.ErrAmbiguous, Ambiguous, CodeAmbiguous},
		{"uninitialized store is a config problem", store.ErrNotInitialized, Config, CodeConfig},
		{"usage", Usagef(errors.New("bad flag")), Usage, CodeUsage},
		{"config", Configf(errors.New("missing token")), Config, CodeConfig},
		{"provider", Providerf(errors.New("timeout")), Provider, CodeProvider},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			code, jsonCode := Classify(tc.err)
			if code != tc.wantCode || jsonCode != tc.wantJSON {
				t.Errorf("Classify() = (%d, %q), want (%d, %q)", code, jsonCode, tc.wantCode, tc.wantJSON)
			}
		})
	}
}

// Classification must survive the wrapping that happens as an error travels up
// through the store and the command layer.
func TestClassifyThroughWrapping(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"wrapped sentinel", fmt.Errorf("get task: %w", store.ErrNotFound), NotFound},
		{"doubly wrapped sentinel", fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", store.ErrAmbiguous)), Ambiguous},
		{"wrapped usage error", fmt.Errorf("add: %w", Usagef(errors.New("bad value"))), Usage},
		{"wrapped config error", fmt.Errorf("load: %w", Configf(errors.New("no url"))), Config},
		{"wrapped provider error", fmt.Errorf("list: %w", Providerf(errors.New("refused"))), Provider},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if code, _ := Classify(tc.err); code != tc.want {
				t.Errorf("Classify() code = %d, want %d", code, tc.want)
			}
		})
	}
}

// A sentinel takes precedence over the class a wrapper assigned, so a
// not-found that a provider wrapped still exits 5 rather than 4.
func TestSentinelWinsOverWrapperClass(t *testing.T) {
	err := Providerf(fmt.Errorf("query failed: %w", store.ErrNotFound))
	if code, _ := Classify(err); code != NotFound {
		t.Errorf("Classify() code = %d, want %d", code, NotFound)
	}
}

func TestConstructorsPassThroughNil(t *testing.T) {
	for name, got := range map[string]error{
		"Usagef":    Usagef(nil),
		"Configf":   Configf(nil),
		"Providerf": Providerf(nil),
	} {
		if got != nil {
			t.Errorf("%s(nil) = %v, want nil", name, got)
		}
	}
}

// The message must survive classification: it is what the user and the JSON
// error envelope show.
func TestWrappersKeepTheMessage(t *testing.T) {
	for _, err := range []error{
		Usagef(errors.New("bad flag")),
		Configf(errors.New("bad flag")),
		Providerf(errors.New("bad flag")),
	} {
		if err.Error() != "bad flag" {
			t.Errorf("Error() = %q, want %q", err.Error(), "bad flag")
		}
	}
}

// The codes are a documented contract (docs/agents.md); changing one is a
// breaking change, so pin the numbers.
func TestCodesArePinned(t *testing.T) {
	for name, pair := range map[string][2]int{
		"OK":        {OK, 0},
		"Error":     {Error, 1},
		"Usage":     {Usage, 2},
		"Config":    {Config, 3},
		"Provider":  {Provider, 4},
		"NotFound":  {NotFound, 5},
		"Ambiguous": {Ambiguous, 6},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s = %d, want %d: exit codes are part of the documented contract", name, pair[0], pair[1])
		}
	}
}
