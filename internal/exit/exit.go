// Package exit maps failures onto the CLI's fixed exit codes.
//
// The codes are part of the documented contract in docs/agents.md, so that an
// agent or a script can branch on a failure class without parsing prose.
// Changing one is a breaking change.
package exit

import (
	"errors"

	"github.com/soya-miyoshi/todocloud/internal/store"
)

// Codes returned by the process.
const (
	OK        = 0
	Error     = 1
	Usage     = 2
	Config    = 3
	Provider  = 4
	NotFound  = 5
	Ambiguous = 6
)

// Error codes used in the JSON error envelope, one per exit code.
const (
	CodeError     = "error"
	CodeUsage     = "usage"
	CodeConfig    = "config"
	CodeProvider  = "provider"
	CodeNotFound  = "not_found"
	CodeAmbiguous = "ambiguous_id"
)

// usageError marks an error as the user's fault at the command line.
type usageError struct{ error }

func (e usageError) Unwrap() error { return e.error }

// Usagef returns an error that exits with the usage code.
func Usagef(err error) error {
	if err == nil {
		return nil
	}
	return usageError{err}
}

// configError marks a configuration or credential problem.
type configError struct{ error }

func (e configError) Unwrap() error { return e.error }

// Configf returns an error that exits with the config code.
func Configf(err error) error {
	if err == nil {
		return nil
	}
	return configError{err}
}

// providerError marks a provider or network failure.
type providerError struct{ error }

func (e providerError) Unwrap() error { return e.error }

// Providerf returns an error that exits with the provider code.
func Providerf(err error) error {
	if err == nil {
		return nil
	}
	return providerError{err}
}

// Classify returns the exit code and the JSON error code for err.
func Classify(err error) (int, string) {
	switch {
	case err == nil:
		return OK, ""
	case errors.Is(err, store.ErrNotFound):
		return NotFound, CodeNotFound
	case errors.Is(err, store.ErrAmbiguous):
		return Ambiguous, CodeAmbiguous
	case errors.Is(err, store.ErrNotInitialized):
		return Config, CodeConfig
	case errors.Is(err, store.ErrSchemaMismatch):
		// A store at the wrong schema version is a configuration problem
		// whichever way it points: run `tdo migrate`, or upgrade tdo.
		return Config, CodeConfig
	}

	var ue usageError
	if errors.As(err, &ue) {
		return Usage, CodeUsage
	}
	var ce configError
	if errors.As(err, &ce) {
		return Config, CodeConfig
	}
	var pe providerError
	if errors.As(err, &pe) {
		return Provider, CodeProvider
	}
	return Error, CodeError
}
