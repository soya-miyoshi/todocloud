package config

import (
	"fmt"
	"strconv"
	"strings"
)

// This file implements a deliberately tiny TOML reader.
//
// The project's dependency policy (CLAUDE.md §3) does not allow a TOML
// library, and the configuration file the CLI reads is a flat list of string,
// integer and boolean settings in at most one level of tables. So instead of a
// general-purpose parser this is a line-based reader for exactly that subset,
// which rejects everything else with a line number. It is not exported as a
// TOML API and must not grow into one.

// valueKind names the three scalar kinds the subset accepts.
type valueKind int

const (
	kindString valueKind = iota
	kindInt
	kindBool
)

// tomlValue is one scalar setting together with the line it came from, so that
// a warning or an error can point the user at the right place.
type tomlValue struct {
	kind valueKind
	str  string
	num  int64
	flag bool
	line int
}

// tomlEntry is a key/value pair with the table it belongs to. The root table
// is named "".
type tomlEntry struct {
	table string
	key   string
	value tomlValue
}

// tomlFile is the parsed document. Entries are kept in file order so that
// anything derived from them (such as the token-shaped-key warnings) is
// deterministic.
type tomlFile struct {
	entries []tomlEntry
}

// string returns the string value of table.key, and whether it was present as
// a string. A value of another kind is reported as absent by this accessor;
// kindOf lets the caller produce a better message.
func (f *tomlFile) string(table, key string) (string, bool) {
	v, ok := f.lookup(table, key)
	if !ok || v.kind != kindString {
		return "", false
	}
	return v.str, true
}

// lookup returns the raw value of table.key.
func (f *tomlFile) lookup(table, key string) (tomlValue, bool) {
	for _, e := range f.entries {
		if e.table == table && e.key == key {
			return e.value, true
		}
	}
	return tomlValue{}, false
}

// subsetNote is appended to every rejection, so the user understands that the
// file is not being read by a full TOML implementation.
const subsetNote = "this file format is a subset of TOML: comments, [table] headers one level deep, and string, integer and boolean values"

// parseTOML reads the supported subset of TOML from src.
func parseTOML(src string) (*tomlFile, error) {
	f := &tomlFile{}
	seen := map[string]bool{}
	table := ""

	for i, raw := range strings.Split(src, "\n") {
		line := i + 1
		text := strings.TrimRight(raw, "\r")
		text = strings.TrimSpace(text)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}

		if strings.HasPrefix(text, "[") {
			name, err := parseTableHeader(text, line)
			if err != nil {
				return nil, err
			}
			table = name
			continue
		}

		eq := strings.IndexByte(text, '=')
		if eq < 0 {
			return nil, fmt.Errorf("line %d: expected a comment, a [table] header or a key = value pair; %s", line, subsetNote)
		}
		key := strings.TrimSpace(text[:eq])
		if err := checkBareKey(key, line); err != nil {
			return nil, err
		}
		value, err := parseValue(strings.TrimSpace(text[eq+1:]), line)
		if err != nil {
			return nil, err
		}

		qualified := table + "." + key
		if seen[qualified] {
			return nil, fmt.Errorf("line %d: duplicate key %q in table %s", line, key, tableLabel(table))
		}
		seen[qualified] = true
		f.entries = append(f.entries, tomlEntry{table: table, key: key, value: value})
	}
	return f, nil
}

// tableLabel renders a table name for a message, naming the root table in
// words because it has no header.
func tableLabel(table string) string {
	if table == "" {
		return "the top level"
	}
	return "[" + table + "]"
}

// parseTableHeader reads a "[name]" line. Nested headers are rejected.
func parseTableHeader(text string, line int) (string, error) {
	if strings.HasPrefix(text, "[[") {
		return "", fmt.Errorf("line %d: array-of-tables headers are not supported; %s", line, subsetNote)
	}
	end := strings.IndexByte(text, ']')
	if end < 0 {
		return "", fmt.Errorf("line %d: unterminated table header, expected a closing ]", line)
	}
	if rest := strings.TrimSpace(text[end+1:]); rest != "" && !strings.HasPrefix(rest, "#") {
		return "", fmt.Errorf("line %d: unexpected text after the table header: %q", line, rest)
	}
	name := strings.TrimSpace(text[1:end])
	if strings.Contains(name, ".") {
		return "", fmt.Errorf("line %d: nested table header [%s] is not supported, tables are one level deep; %s", line, name, subsetNote)
	}
	if err := checkBareKey(name, line); err != nil {
		return "", err
	}
	return name, nil
}

// checkBareKey rejects anything but a bare key, which is all the subset uses.
func checkBareKey(key string, line int) error {
	if key == "" {
		return fmt.Errorf("line %d: empty key; %s", line, subsetNote)
	}
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return fmt.Errorf("line %d: invalid character %q in key %q, keys are bare words; %s", line, r, key, subsetNote)
		}
	}
	return nil
}

// parseValue reads one scalar value, which may be followed by a comment.
func parseValue(text string, line int) (tomlValue, error) {
	if text == "" {
		return tomlValue{}, fmt.Errorf("line %d: missing value after =", line)
	}
	switch text[0] {
	case '"', '\'':
		return parseStringValue(text, line)
	case '[':
		return tomlValue{}, fmt.Errorf("line %d: array values are not supported; %s", line, subsetNote)
	case '{':
		return tomlValue{}, fmt.Errorf("line %d: inline table values are not supported; %s", line, subsetNote)
	}

	// A bare value ends at a comment.
	bare := text
	if i := strings.IndexByte(bare, '#'); i >= 0 {
		bare = bare[:i]
	}
	bare = strings.TrimSpace(bare)
	switch bare {
	case "true":
		return tomlValue{kind: kindBool, flag: true, line: line}, nil
	case "false":
		return tomlValue{kind: kindBool, flag: false, line: line}, nil
	}
	if n, err := strconv.ParseInt(bare, 10, 64); err == nil {
		return tomlValue{kind: kindInt, num: n, line: line}, nil
	}
	return tomlValue{}, fmt.Errorf("line %d: unsupported value %q, expected a quoted string, an integer or true/false; %s", line, bare, subsetNote)
}

// parseStringValue reads a basic ("...") or literal ('...') string. A # inside
// the quotes is a literal character, not the start of a comment.
func parseStringValue(text string, line int) (tomlValue, error) {
	quote := text[0]
	var b strings.Builder
	for i := 1; i < len(text); i++ {
		c := text[i]
		if quote == '"' && c == '\\' {
			if i+1 >= len(text) {
				return tomlValue{}, fmt.Errorf("line %d: unterminated string", line)
			}
			i++
			switch text[i] {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			default:
				return tomlValue{}, fmt.Errorf("line %d: unsupported escape %q in string; %s", line, `\`+string(text[i]), subsetNote)
			}
			continue
		}
		if c == quote {
			if rest := strings.TrimSpace(text[i+1:]); rest != "" && !strings.HasPrefix(rest, "#") {
				return tomlValue{}, fmt.Errorf("line %d: unexpected text after the value: %q", line, rest)
			}
			return tomlValue{kind: kindString, str: b.String(), line: line}, nil
		}
		b.WriteByte(c)
	}
	return tomlValue{}, fmt.Errorf("line %d: unterminated string, expected a closing %c", line, quote)
}
