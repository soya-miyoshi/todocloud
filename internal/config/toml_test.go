package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTOMLAcceptedForms(t *testing.T) {
	tests := []struct {
		name  string
		src   string
		table string
		key   string
		want  tomlValue
	}{
		{
			name: "double quoted string",
			src:  `provider = "sqlite"`,
			key:  "provider",
			want: tomlValue{kind: kindString, str: "sqlite", line: 1},
		},
		{
			name: "single quoted literal string",
			src:  `provider = 'turso'`,
			key:  "provider",
			want: tomlValue{kind: kindString, str: "turso", line: 1},
		},
		{
			name: "trailing comment after a string",
			src:  `provider = "sqlite" # the default`,
			key:  "provider",
			want: tomlValue{kind: kindString, str: "sqlite", line: 1},
		},
		{
			name: "hash inside a string is literal",
			src:  `url = "libsql://example.turso.io/#fragment"`,
			key:  "url",
			want: tomlValue{kind: kindString, str: "libsql://example.turso.io/#fragment", line: 1},
		},
		{
			name: "hash inside a literal string is literal",
			src:  `url = 'libsql://example.turso.io/#fragment'`,
			key:  "url",
			want: tomlValue{kind: kindString, str: "libsql://example.turso.io/#fragment", line: 1},
		},
		{
			name: "escapes in a basic string",
			src:  `note = "a\tb\nc\"d\\e"`,
			key:  "note",
			want: tomlValue{kind: kindString, str: "a\tb\nc\"d\\e", line: 1},
		},
		{
			name: "bare integer",
			src:  "timeout = 30",
			key:  "timeout",
			want: tomlValue{kind: kindInt, num: 30, line: 1},
		},
		{
			name: "negative integer with a trailing comment",
			src:  "offset = -5 # behind",
			key:  "offset",
			want: tomlValue{kind: kindInt, num: -5, line: 1},
		},
		{
			name: "true",
			src:  "color = true",
			key:  "color",
			want: tomlValue{kind: kindBool, flag: true, line: 1},
		},
		{
			name: "false",
			src:  "color = false",
			key:  "color",
			want: tomlValue{kind: kindBool, flag: false, line: 1},
		},
		{
			name:  "table header",
			src:   "[turso]\nurl = \"libsql://example.turso.io\"",
			table: "turso",
			key:   "url",
			want:  tomlValue{kind: kindString, str: "libsql://example.turso.io", line: 2},
		},
		{
			name:  "table header with a trailing comment",
			src:   "[sqlite] # local\npath = \"/tmp/tasks.db\"",
			table: "sqlite",
			key:   "path",
			want:  tomlValue{kind: kindString, str: "/tmp/tasks.db", line: 2},
		},
		{
			name:  "surrounding whitespace and blank lines",
			src:   "\n   # comment\n\n\t[d1]  \n   account_id   =   \"00000000-0000-0000-0000-000000000000\"   \n",
			table: "d1",
			key:   "account_id",
			want:  tomlValue{kind: kindString, str: "00000000-0000-0000-0000-000000000000", line: 5},
		},
		{
			name:  "crlf line endings",
			src:   "[turso]\r\nurl = \"libsql://example.turso.io\"\r\n",
			table: "turso",
			key:   "url",
			want:  tomlValue{kind: kindString, str: "libsql://example.turso.io", line: 2},
		},
		{
			name: "key with an underscore and a dash",
			src:  "project_id = \"my-project-id\"",
			key:  "project_id",
			want: tomlValue{kind: kindString, str: "my-project-id", line: 1},
		},
		{
			name: "empty string value",
			src:  `path = ""`,
			key:  "path",
			want: tomlValue{kind: kindString, str: "", line: 1},
		},
		{
			name:  "same key in two different tables",
			src:   "[turso]\ntoken_hint = \"a\"\n[d1]\ntoken_hint = \"b\"",
			table: "d1",
			key:   "token_hint",
			want:  tomlValue{kind: kindString, str: "b", line: 4},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, err := parseTOML(tt.src)
			if err != nil {
				t.Fatalf("parseTOML: unexpected error: %v", err)
			}
			got, ok := f.lookup(tt.table, tt.key)
			if !ok {
				t.Fatalf("key %q in table %q not found", tt.key, tt.table)
			}
			if got != tt.want {
				t.Fatalf("value = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseTOMLRejections(t *testing.T) {
	tests := []struct {
		name     string
		src      string
		wantLine string
		wantText string
	}{
		{
			name:     "unterminated double quoted string",
			src:      "provider = \"sqlite",
			wantLine: "line 1:",
			wantText: "unterminated string",
		},
		{
			name:     "unterminated literal string on a later line",
			src:      "# comment\n[turso]\nurl = 'libsql://example.turso.io",
			wantLine: "line 3:",
			wantText: "unterminated string",
		},
		{
			name:     "bare word line",
			src:      "provider = \"sqlite\"\nnonsense",
			wantLine: "line 2:",
			wantText: "expected a comment, a [table] header or a key = value pair",
		},
		{
			name:     "duplicate key in the same table",
			src:      "[turso]\nurl = \"libsql://example.turso.io\"\nurl = \"libsql://example.turso.io\"",
			wantLine: "line 3:",
			wantText: "duplicate key",
		},
		{
			name:     "duplicate key at the top level",
			src:      "provider = \"sqlite\"\nprovider = \"turso\"",
			wantLine: "line 2:",
			wantText: "duplicate key",
		},
		{
			name:     "nested table header",
			src:      "[a.b]\nkey_name = \"v\"",
			wantLine: "line 1:",
			wantText: "nested table header",
		},
		{
			name:     "array value",
			src:      "[sqlite]\npaths = [\"a\", \"b\"]",
			wantLine: "line 2:",
			wantText: "array values are not supported",
		},
		{
			name:     "inline table value",
			src:      "sqlite = { path = \"a\" }",
			wantLine: "line 1:",
			wantText: "inline table values are not supported",
		},
		{
			name:     "array of tables header",
			src:      "[[turso]]\nurl = \"libsql://example.turso.io\"",
			wantLine: "line 1:",
			wantText: "array-of-tables headers are not supported",
		},
		{
			name:     "unterminated table header",
			src:      "[turso\nurl = \"libsql://example.turso.io\"",
			wantLine: "line 1:",
			wantText: "unterminated table header",
		},
		{
			name:     "text after the table header",
			src:      "[turso] junk",
			wantLine: "line 1:",
			wantText: "unexpected text after the table header",
		},
		{
			name:     "text after a string value",
			src:      "provider = \"sqlite\" junk",
			wantLine: "line 1:",
			wantText: "unexpected text after the value",
		},
		{
			name:     "missing value",
			src:      "provider =",
			wantLine: "line 1:",
			wantText: "missing value after =",
		},
		{
			name:     "empty key",
			src:      "= \"sqlite\"",
			wantLine: "line 1:",
			wantText: "empty key",
		},
		{
			name:     "dotted key",
			src:      "turso.url = \"libsql://example.turso.io\"",
			wantLine: "line 1:",
			wantText: "invalid character",
		},
		{
			name:     "float value",
			src:      "timeout = 1.5",
			wantLine: "line 1:",
			wantText: "unsupported value",
		},
		{
			name:     "unsupported escape",
			src:      `note = "a\qb"`,
			wantLine: "line 1:",
			wantText: "unsupported escape",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseTOML(tt.src)
			if err == nil {
				t.Fatalf("parseTOML(%q): expected an error", tt.src)
			}
			if !strings.HasPrefix(err.Error(), tt.wantLine) {
				t.Errorf("error %q does not start with %q", err.Error(), tt.wantLine)
			}
			if !strings.Contains(err.Error(), tt.wantText) {
				t.Errorf("error %q does not mention %q", err.Error(), tt.wantText)
			}
		})
	}
}

// TestParseTOMLReadsExampleFile pins the parser to the file the project ships,
// which is the only file it has to be able to read.
func TestParseTOMLReadsExampleFile(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "config.example.toml"))
	if err != nil {
		t.Fatalf("reading config.example.toml: %v", err)
	}
	f, err := parseTOML(string(data))
	if err != nil {
		t.Fatalf("parseTOML(config.example.toml): %v", err)
	}

	want := []struct{ table, key, value string }{
		{"", "provider", "sqlite"},
		{"sqlite", "path", "~/.local/share/todocloud/tasks.db"},
		{"turso", "url", "libsql://example.turso.io"},
		{"d1", "account_id", "00000000-0000-0000-0000-000000000000"},
		{"d1", "database_id", "00000000-0000-0000-0000-000000000000"},
	}
	for _, w := range want {
		got, ok := f.string(w.table, w.key)
		if !ok {
			t.Errorf("%s.%s not found", w.table, w.key)
			continue
		}
		if got != w.value {
			t.Errorf("%s.%s = %q, want %q", w.table, w.key, got, w.value)
		}
	}

	// The example file must not carry a token key of its own.
	for _, e := range f.entries {
		if isTokenKey(e.key) {
			t.Errorf("config.example.toml line %d sets a token-shaped key %q", e.value.line, e.key)
		}
	}
}
