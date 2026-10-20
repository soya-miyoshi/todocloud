package turso

import (
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/storetest"
)

// TestTursoSatisfiesTheProviderContract runs the shared conformance suite
// against the fake pipeline server, which executes the statements this
// provider sends on a real engine. It is the acceptance test for the port:
// the tree rules of PLAN.md §3.1 and the availability computation of §3.3 are
// the shared ones, and this is what proves that sending them over the wire
// did not change any of their answers.
func TestTursoSatisfiesTheProviderContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		f := newFakeServer(t)
		s, err := Open(f.config())
		if err != nil {
			t.Fatalf("opening a store against the fake server: %v", err)
		}
		return s
	})
}
