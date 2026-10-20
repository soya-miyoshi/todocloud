package sqlite_test

import (
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/sqlite"
	"github.com/soya-miyoshi/todocloud/internal/store/storetest"
)

// TestSQLiteSatisfiesTheProviderContract runs the shared conformance suite.
// SQLite is the reference provider, so a failure here is a failure of the
// definition as much as of this implementation.
func TestSQLiteSatisfiesTheProviderContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		s, err := sqlite.Open(sqlite.MemoryPath)
		if err != nil {
			t.Fatalf("opening an in-memory store: %v", err)
		}
		return s
	})
}
