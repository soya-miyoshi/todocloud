package storetest

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/soya-miyoshi/todocloud/internal/store"
)

// schemaSnapshot is everything about a schema that two stores have to agree
// on: which tables exist, and for each of them its columns with their types
// and defaults, its indexes, its foreign keys and its CHECK constraints —
// plus any views and triggers.
//
// It is read from the engine's catalogue rather than from the DDL text,
// because the text legitimately differs. A table that Init created with a
// column and a table a migration added that column to store different
// CREATE TABLE statements and the same schema; comparing the text would
// report a difference that is not one, and a harness that cries wolf is a
// harness that gets skipped.
type schemaSnapshot struct {
	tables map[string]tableSnapshot
	// objects holds views and triggers by name, as normalized SQL. These
	// are only ever created, never altered, so their text is stable.
	objects map[string]string
}

type tableSnapshot struct {
	// columns, indexes, fks and checks are each a sorted list of one-line
	// renderings, so that a difference prints as a readable pair of lines.
	columns []string
	indexes []string
	fks     []string
	checks  []string
}

func (l Ladder) snapshot(t *testing.T, s store.Store) schemaSnapshot {
	t.Helper()
	snap := schemaSnapshot{
		tables:  map[string]tableSnapshot{},
		objects: map[string]string{},
	}

	rows := l.SQL.Query(t, s, `SELECT type, name, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\' ORDER BY type, name`)
	var tables []string
	for _, row := range rows {
		kind, name, ddl := row[0], row[1], row[2]
		switch kind {
		case "table":
			tables = append(tables, name)
			snap.tables[name] = tableSnapshot{checks: checksIn(ddl)}
		case "view", "trigger":
			snap.objects[kind+" "+name] = normalizeSQL(ddl)
		}
		// Indexes are read per table below, so that an index is reported
		// against the table it belongs to.
	}

	for _, name := range tables {
		tbl := snap.tables[name]
		for _, c := range l.SQL.Query(t, s, fmt.Sprintf(`PRAGMA table_info(%s)`, quoteIdent(name))) {
			// c is cid, name, type, notnull, dflt_value, pk. cid is left
			// out on purpose: SQLite's ALTER TABLE ADD COLUMN appends, so a
			// column a migration added sits at a different position than
			// the same column in a fresh CREATE TABLE. That is a difference
			// in layout, not in schema, and no code here depends on
			// ordinal position — every statement names its columns.
			tbl.columns = append(tbl.columns, fmt.Sprintf(
				"%s type=%s notnull=%s default=%s pk=%s", c[1], c[2], c[3], c[4], c[5]))
		}
		for _, fk := range l.SQL.Query(t, s, fmt.Sprintf(`PRAGMA foreign_key_list(%s)`, quoteIdent(name))) {
			// fk is id, seq, table, from, to, on_update, on_delete, match.
			tbl.fks = append(tbl.fks, fmt.Sprintf(
				"%s -> %s(%s) on_update=%s on_delete=%s match=%s", fk[3], fk[2], fk[4], fk[5], fk[6], fk[7]))
		}
		for _, idx := range l.SQL.Query(t, s, fmt.Sprintf(`PRAGMA index_list(%s)`, quoteIdent(name))) {
			// idx is seq, name, unique, origin, partial. The name is used
			// only for an index the DDL names: SQLite invents the name of
			// the index behind a UNIQUE or PRIMARY KEY clause, and that
			// invented name depends on the order the constraints were
			// written in rather than on what the schema means.
			idxName, unique, origin, partial := idx[1], idx[2], idx[3], idx[4]
			var cols []string
			for _, col := range l.SQL.Query(t, s, fmt.Sprintf(`PRAGMA index_info(%s)`, quoteIdent(idxName))) {
				cols = append(cols, col[2])
			}
			label := idxName
			if origin != "c" {
				label = "(implicit)"
			}
			tbl.indexes = append(tbl.indexes, fmt.Sprintf(
				"%s on (%s) unique=%s origin=%s partial=%s", label, strings.Join(cols, ", "), unique, origin, partial))
		}
		sort.Strings(tbl.columns)
		sort.Strings(tbl.indexes)
		sort.Strings(tbl.fks)
		snap.tables[name] = tbl
	}
	return snap
}

// diffSchemas fails with the first difference it finds, naming the rule
// rather than only the values.
func diffSchemas(t *testing.T, rule string, want, got schemaSnapshot) {
	t.Helper()
	if diff := compareSnapshots(want, got); diff != "" {
		t.Fatalf("%s\n  %s", rule, diff)
	}
}

// compareSnapshots describes the first difference between two schemas, or
// returns "" when they are the same schema. It is separate from the
// assertion so that the harness's own test can check that it finds a
// difference without failing the test that is checking it.
func compareSnapshots(want, got schemaSnapshot) string {
	wantTables, gotTables := names(want.tables), names(got.tables)
	if diff := diffLists(wantTables, gotTables); diff != "" {
		return "the tables differ: " + diff
	}
	for _, name := range wantTables {
		w, g := want.tables[name], got.tables[name]
		for _, part := range []struct {
			what        string
			want, got   []string
			consequence string
		}{
			{"columns", w.columns, g.columns, "a column that means one thing on a new install and another on an upgraded one"},
			{"indexes", w.indexes, g.indexes, "a query that is fast on a new store and a table scan on an old one"},
			{"foreign keys", w.fks, g.fks, "a referential rule that holds on one install and not on another"},
			{"CHECK constraints", w.checks, g.checks, "a value that one install refuses and another accepts"},
		} {
			if diff := diffLists(part.want, part.got); diff != "" {
				return fmt.Sprintf("table %q: the %s differ: %s\n  left unfixed this becomes %s",
					name, part.what, diff, part.consequence)
			}
		}
	}

	if diff := diffLists(names2(want.objects), names2(got.objects)); diff != "" {
		return "the views and triggers differ: " + diff
	}
	for _, name := range names2(want.objects) {
		if got.objects[name] != want.objects[name] {
			return fmt.Sprintf("%s differs:\n    init:    %s\n    migrate: %s", name, want.objects[name], got.objects[name])
		}
	}
	return ""
}

func names(m map[string]tableSnapshot) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func names2(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// diffLists returns a readable description of the first difference between
// two sorted lists, or "" when they are equal.
func diffLists(want, got []string) string {
	missing := subtract(want, got)
	extra := subtract(got, want)
	switch {
	case len(missing) == 0 && len(extra) == 0:
		return ""
	case len(extra) == 0:
		return fmt.Sprintf("the migrated store is missing %s", strings.Join(missing, "; "))
	case len(missing) == 0:
		return fmt.Sprintf("the migrated store has %s, which a freshly initialized one does not", strings.Join(extra, "; "))
	default:
		return fmt.Sprintf("init has %s where migrate has %s", strings.Join(missing, "; "), strings.Join(extra, "; "))
	}
}

func subtract(a, b []string) []string {
	have := make(map[string]int, len(b))
	for _, s := range b {
		have[s]++
	}
	var out []string
	for _, s := range a {
		if have[s] > 0 {
			have[s]--
			continue
		}
		out = append(out, s)
	}
	return out
}

// checksIn pulls the CHECK clauses out of a CREATE TABLE statement. The
// pragmas report columns, indexes and foreign keys but say nothing about a
// CHECK, and a constraint that a fresh store enforces and a migrated one
// does not is exactly the kind of difference this harness exists to find.
//
// It is a scanner rather than a parser: it finds the keyword and takes the
// balanced parentheses after it, ignoring anything inside a string literal.
func checksIn(ddl string) []string {
	var out []string
	lower := strings.ToLower(ddl)
	for i := 0; i+5 <= len(lower); {
		at := strings.Index(lower[i:], "check")
		if at < 0 {
			break
		}
		at += i
		i = at + 5
		if !isWordBoundary(lower, at, at+5) {
			continue
		}
		open := at + 5
		for open < len(ddl) && (ddl[open] == ' ' || ddl[open] == '\n' || ddl[open] == '\t' || ddl[open] == '\r') {
			open++
		}
		if open >= len(ddl) || ddl[open] != '(' {
			continue
		}
		depth, quote := 0, byte(0)
		for j := open; j < len(ddl); j++ {
			c := ddl[j]
			switch {
			case quote != 0:
				if c == quote {
					quote = 0
				}
			case c == '\'' || c == '"':
				quote = c
			case c == '(':
				depth++
			case c == ')':
				depth--
				if depth == 0 {
					out = append(out, normalizeSQL(ddl[open:j+1]))
					i = j + 1
					j = len(ddl)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func isWordBoundary(s string, start, end int) bool {
	before := start == 0 || !isWordByte(s[start-1])
	after := end >= len(s) || !isWordByte(s[end])
	return before && after
}

func isWordByte(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// normalizeSQL collapses whitespace and case so that two statements that say
// the same thing compare equal.
func normalizeSQL(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// quoteIdent renders an identifier for a PRAGMA. The names come from the
// engine's own catalogue, but doubling an embedded quote costs nothing and
// keeps the harness from being the one place that splices a name into SQL
// unguarded.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
