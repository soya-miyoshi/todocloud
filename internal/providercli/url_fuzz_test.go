package providercli

import (
	"strings"
	"testing"
)

// A Turso URL comes from the user's config file or from the provider CLI's
// output, and the name read out of it is offered to commands that put it on a
// child process's argv. What is asserted here is what the function actually
// guarantees: a certain answer is non-empty, lower-cased, and carries none of
// the delimiters the host is actually split on: the scheme separator, a
// path, query or fragment, and userinfo. A colon or a space can survive,
// because only the LAST colon is read as a port and whitespace is trimmed only
// at the ends.
//
// It is deliberately NOT asserted that the name passes validateDatabaseName,
// because it does not: the name is a slice of the raw host label, so it may
// hold any byte and may even start with a dash. See
// TestDatabaseFromURLCanReturnANameItsOwnCommandsRefuse.
func FuzzDatabaseFromURL(f *testing.F) {
	seeds := []string{
		"",
		" ",
		"libsql://example.turso.io",
		"libsql://tasks-acme.turso.io",
		"https://tasks-acme.turso.io/v2/pipeline?x=1#frag",
		"libsql://user:pass@tasks-acme.turso.io:443/db",
		"LIBSQL://TASKS-ACME.TURSO.IO",
		"tasks-acme.turso.io",
		"tasks-with-many-dashes-acme.turso.io",
		"-acme.turso.io",
		"tasks-.turso.io",
		"-.turso.io",
		"--.turso.io",
		"--0.turso.io",
		"-x-y.turso.io",
		"libsql://tasks x-acme.turso.io",
		":-0.turso.io:",
		".turso.io",
		"a.b-c.turso.io",
		"turso.io",
		"example.com",
		"libsql://tasks-acme.turso.io.evil.com",
		"libsql://tasks-acme.TURSO.io",
		"libsql://" + strings.Repeat("a-", 200) + "b.turso.io",
		"libsql://tasks-acme.turso.io:notaport",
		"libsql://tasks\x00-acme.turso.io",
		"libsql://tasks-\xff\xfe.turso.io",
		"libsql://tasks-acme.turso.io/#@evil.turso.io",
		"://tasks-acme.turso.io",
		"libsql://@tasks-acme.turso.io",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, url string) {
		name, ok := DatabaseFromURL(url)
		if !ok {
			if name != "" {
				t.Fatalf("DatabaseFromURL(%q) reported an uncertain answer but returned %q", url, name)
			}
			return
		}
		if name == "" {
			t.Fatalf("DatabaseFromURL(%q) returned an empty name as certain", url)
		}
		if i := strings.IndexAny(name, "./?#@"); i >= 0 {
			t.Fatalf("DatabaseFromURL(%q) = %q, which holds the delimiter %q", url, name, name[i])
		}
		if strings.ToLower(name) != name {
			t.Fatalf("DatabaseFromURL(%q) = %q, which was not lower-cased", url, name)
		}
	})
}

// A name sliced out of a host label is only reported as certain when it is a
// name this package would also accept as an argument. Anything else — a NUL
// byte, whitespace, a flag-shaped leading dash — is reported as uncertain, so
// the caller falls back to `turso db list` or asks for --database instead of
// carrying a value that the next call refuses.
func TestDatabaseFromURLOnlyReportsNamesItsOwnCommandsAccept(t *testing.T) {
	uncertain := []string{
		"libsql://tasks\x00-acme.turso.io", // a NUL byte in the host label
		"--0.turso.io",                     // a name a child would read as a flag
		"libsql://tasks x-acme.turso.io",   // whitespace inside the label
		":-0.turso.io:",                    // a colon that is not the last one
	}
	for _, url := range uncertain {
		if name, ok := DatabaseFromURL(url); ok {
			t.Errorf("DatabaseFromURL(%q) = %q, true; want it reported as uncertain", url, name)
		}
	}

	// Whatever it does report has to survive the validation every command
	// applies, which is the property that makes "certain" mean something.
	for _, url := range []string{
		"libsql://tasks-acme.turso.io",
		"libsql://my_tasks-acme.turso.io",
		"libsql://my-tasks-acme.turso.io",
	} {
		name, ok := DatabaseFromURL(url)
		if !ok {
			t.Errorf("DatabaseFromURL(%q) is uncertain, want a name", url)
			continue
		}
		if err := validateDatabaseName(name); err != nil {
			t.Errorf("DatabaseFromURL(%q) = %q, which its own commands refuse: %v", url, name, err)
		}
	}
}
