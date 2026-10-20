package id

import (
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNewProducesValidIDs(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		got := New()
		if len(got) != Length {
			t.Fatalf("New() = %q, want %d characters", got, Length)
		}
		if !Valid(got) {
			t.Fatalf("New() produced %q, which Valid rejects", got)
		}
		if seen[got] {
			t.Fatalf("New() repeated %q", got)
		}
		seen[got] = true
	}
}

// Lexicographic order must equal creation order even within a single
// millisecond. A ULID's timestamp is millisecond-resolution, so without
// monotonic entropy a burst of ids would sort arbitrarily — and `tdo ls`
// orders by id, which is what the short numbers are assigned from. An
// arbitrary order there means `tdo done 1` can complete the wrong task.
func TestIDsGeneratedInOneBurstSortInCreationOrder(t *testing.T) {
	ids := make([]string, 0, 500)
	for i := 0; i < 500; i++ {
		ids = append(ids, New())
	}

	sorted := make([]string, len(ids))
	copy(sorted, ids)
	sort.Strings(sorted)

	for i := range ids {
		if ids[i] != sorted[i] {
			t.Fatalf("id %d of a burst is out of order:\n generated: %s\n    sorted: %s", i, ids[i], sorted[i])
		}
	}
}

// Generating from several goroutines must stay ordered per observation and
// must never produce a duplicate; the generator is shared, so this is also the
// race-detector's entry point into it.
func TestConcurrentGenerationIsUniqueAndValid(t *testing.T) {
	const workers, each = 8, 200

	results := make(chan string, workers*each)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				results <- New()
			}
		}()
	}
	wg.Wait()
	close(results)

	seen := make(map[string]bool, workers*each)
	for got := range results {
		if !Valid(got) {
			t.Fatalf("New() produced %q, which Valid rejects", got)
		}
		if seen[got] {
			t.Fatalf("New() repeated %q across goroutines", got)
		}
		seen[got] = true
	}
	if len(seen) != workers*each {
		t.Errorf("got %d distinct ids, want %d", len(seen), workers*each)
	}
}

// The same property across a span of time, which is what a user's list relies
// on over days rather than milliseconds.
func TestIDsSortByCreationTime(t *testing.T) {
	var ids []string
	for i := 0; i < 5; i++ {
		ids = append(ids, New())
		time.Sleep(2 * time.Millisecond)
	}

	sorted := make([]string, len(ids))
	copy(sorted, ids)
	sort.Strings(sorted)

	for i := range ids {
		if ids[i] != sorted[i] {
			t.Fatalf("ids are not in lexicographic creation order:\n generated: %v\n    sorted: %v", ids, sorted)
		}
	}
}

func TestValid(t *testing.T) {
	valid := New()
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"generated", valid, true},
		{"lower-cased copy", strings.ToLower(valid), true},
		{"too short", valid[:25], false},
		{"too long", valid + "0", false},
		{"excluded letter I", strings.Repeat("I", Length), false},
		{"empty", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Valid(tc.in); got != tc.want {
				t.Errorf("Valid(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestValidPrefix(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"short prefix", "01J3", true},
		{"lower case", "01j3", true},
		{"surrounded by spaces", " 01J3 ", true},
		{"a full id is a prefix of itself", "01J3ZQK8V9XW5S6R7T8Y9Z0A1B", true},
		{"empty", "", false},
		{"longer than an id", strings.Repeat("0", Length+1), false},
		{"excluded letter L", "01L3", false},
		{"excluded letter O", "01O3", false},
		{"excluded letter U", "01U3", false},
		{"punctuation", "01-3", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidPrefix(tc.in); got != tc.want {
				t.Errorf("ValidPrefix(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalize(t *testing.T) {
	if got := Normalize(" 01j3 "); got != "01J3" {
		t.Errorf("Normalize() = %q, want %q", got, "01J3")
	}
}

func TestShort(t *testing.T) {
	full := "01J3ZQK8V9XW5S6R7T8Y9Z0A1B"
	for _, tc := range []struct {
		n    int
		want string
	}{
		{4, "01J3"},
		{0, full},
		{-1, full},
		{Length, full},
		{Length + 10, full},
	} {
		if got := Short(full, tc.n); got != tc.want {
			t.Errorf("Short(id, %d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}
