package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// This file is the other half of the hand-written TOML subset: a writer that
// edits the user's config file in place.
//
// Three properties shape it, and each one is a guard rather than a
// convention:
//
//   - It never writes a credential. A key named "token" — or any of the other
//     secret-shaped spellings the reader already refuses — is rejected inside
//     the writer, not at the call site, so a future caller cannot reach disk
//     with one by mistake. Tokens live in the OS keychain or the environment.
//   - It writes only where the reader is willing to read a token from: the XDG
//     config file or $TODOCLOUD_CONFIG, and never inside a git repository.
//     Writing a path into a repository is how a config file gets committed.
//   - It preserves the file. Comments, blank lines, key order, spacing and
//     every table or key it was not asked about come through byte for byte: a
//     writer that reformats someone's file is a writer they turn off.

// fileHeader is written at the top of a config file this package creates. It
// is never added to a file that already exists.
const fileHeader = `# todocloud configuration.
# Written by tdo; your own comments, spacing and key order are preserved.
# Never move this file inside a git repository, and never put a token here:
# ` + "`tdo login`" + ` stores tokens in the OS keychain.
`

// ErrSecretKey is returned when a caller asks the writer to store a key that
// is assumed to hold a credential. It is a programming error as much as a
// user error, which is why it is checked here and not only in the CLI.
var ErrSecretKey = errors.New("refusing to write a credential to the config file")

// RefusedError reports that the writer declined to touch a path. Reason is one
// sentence naming the guard that refused and what to do instead.
type RefusedError struct {
	Path   string
	Reason string
}

func (e *RefusedError) Error() string {
	if e.Path == "" {
		return "refusing to write the config file: " + e.Reason
	}
	return fmt.Sprintf("refusing to write config file %s: %s", e.Path, e.Reason)
}

// Setting is one key to write. Table is "" for a top-level key. Only string
// values are written: every setting the CLI owns is a string, and a writer
// that cannot be asked for other kinds cannot get their quoting wrong.
type Setting struct {
	Table string
	Key   string
	Value string
}

// Name renders the setting as the dotted name used in messages and in
// Config.Origins, e.g. "turso.url".
func (s Setting) Name() string {
	if s.Table == "" {
		return s.Key
	}
	return s.Table + "." + s.Key
}

// Change is what one Setting did to the file.
type Change struct {
	// Name is the dotted setting name, e.g. "turso.url".
	Name string
	// Value is what the key now holds.
	Value string
	// Previous is what it held before, empty when the key was added.
	Previous string
	// Added is true when the key was not in the file at all.
	Added bool
	// Changed is false when the file already said exactly this.
	Changed bool
}

// WriteResult describes a completed write.
type WriteResult struct {
	// Path is the file that was written.
	Path string
	// Created is true when the file did not exist beforehand.
	Created bool
	// Changes is one entry per requested setting, in the order requested.
	Changes []Change
	// Wrote is false when every setting already held the requested value, in
	// which case the file was left exactly as it was.
	Wrote bool
}

// WriteOptions controls Set.
type WriteOptions struct {
	// Getenv defaults to os.Getenv. Tests inject a fake environment.
	//
	// Unlike the reader, the writer has no fallback to the process-wide home
	// directory: when the injected environment names neither XDG_CONFIG_HOME
	// nor HOME, there is no file to write and Set refuses. A writer that could
	// reach a real home directory from a fake environment is one a test can
	// point at the developer's own configuration.
	Getenv func(string) string
	// ConfigPath mirrors the --config flag. It is honoured only when it names
	// the same file the reader would accept a token from; anything else is
	// refused, for the same reason the reader refuses it.
	ConfigPath string
}

// Set writes settings into the user's config file, creating it when it does
// not exist, and returns what it did. The file is replaced atomically: the new
// contents are written to a temporary file in the same directory and renamed
// over the target, so an interrupted write cannot truncate the old one.
func Set(opts WriteOptions, settings ...Setting) (*WriteResult, error) {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	if len(settings) == 0 {
		return nil, errors.New("no settings to write")
	}
	for _, s := range settings {
		if err := checkWritableSetting(s); err != nil {
			return nil, err
		}
	}

	path, err := writablePath(getenv, opts.ConfigPath)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	created := false
	switch {
	case err == nil:
	case errors.Is(err, os.ErrNotExist):
		created = true
		data = []byte(fileHeader)
	default:
		return nil, fmt.Errorf("reading config file %s: %w", path, err)
	}

	// A file this writer cannot read, it must not rewrite: reformatting the
	// unparsed remains of a file the user hand-edited would lose it.
	if !created {
		if _, err := parseTOML(string(data)); err != nil {
			return nil, &RefusedError{Path: path, Reason: fmt.Sprintf(
				"it does not parse (%v), and rewriting a file this reader does not understand would lose what is in it; fix the file by hand", err)}
		}
	}

	out, changes, err := applySettings(string(data), settings)
	if err != nil {
		return nil, fmt.Errorf("editing config file %s: %w", path, err)
	}

	// Belt and braces: the edited file must still parse, and must read back
	// exactly what was asked for. A quoting bug here would otherwise reach the
	// user's disk.
	if err := verify(out, settings); err != nil {
		return nil, fmt.Errorf("editing config file %s would have produced a file tdo cannot read back: %w", path, err)
	}

	result := &WriteResult{Path: path, Created: created, Changes: changes}
	if !created && !anyChanged(changes) {
		// Nothing to do, so nothing is touched: no rename, no new mtime.
		return result, nil
	}
	if err := writeFileAtomic(path, []byte(out)); err != nil {
		return nil, err
	}
	result.Wrote = true
	return result, nil
}

// anyChanged reports whether any requested setting actually changed the file.
func anyChanged(changes []Change) bool {
	for _, c := range changes {
		if c.Changed {
			return true
		}
	}
	return false
}

// checkWritableSetting applies the two rules that hold whatever the caller
// intended: the names must be bare keys this reader can read back, and the
// key must not be one that holds a credential.
func checkWritableSetting(s Setting) error {
	if s.Table != "" {
		if err := checkBareKey(s.Table, 0); err != nil {
			return fmt.Errorf("invalid table name %q", s.Table)
		}
	}
	if err := checkBareKey(s.Key, 0); err != nil {
		return fmt.Errorf("invalid key %q", s.Key)
	}
	if isTokenKey(s.Key) {
		return fmt.Errorf("%w: %q holds a credential, and tdo never writes one to a file. Run `tdo login`, which stores the token in the OS keychain, or set %s in the environment",
			ErrSecretKey, s.Name(), tokenEnvHint(s.Table))
	}
	return nil
}

// ParseKey splits a dotted setting name into a table and a key. A bare name is
// a top-level key; anything deeper than one level is rejected, because the
// file format is one level of tables.
func ParseKey(name string) (table, key string, err error) {
	name = strings.TrimSpace(name)
	switch strings.Count(name, ".") {
	case 0:
		key = name
	case 1:
		i := strings.IndexByte(name, '.')
		table, key = name[:i], name[i+1:]
	default:
		return "", "", fmt.Errorf("invalid key %q: tables are one level deep, so a key is either `key` or `table.key`", name)
	}
	if key == "" || (strings.Contains(name, ".") && table == "") {
		return "", "", fmt.Errorf("invalid key %q: expected `key` or `table.key`", name)
	}
	if table != "" {
		if err := checkBareKey(table, 0); err != nil {
			return "", "", fmt.Errorf("invalid table name %q in key %q: tables are bare words", table, name)
		}
	}
	if err := checkBareKey(key, 0); err != nil {
		return "", "", fmt.Errorf("invalid key %q: keys are bare words", name)
	}
	return table, key, nil
}

// writablePath decides which file to write, and refuses the paths the reader
// would refuse a token from. The guards are deliberately the reader's: a file
// good enough to hold a token is the only file tdo will maintain, because
// anywhere else is somewhere a config file ends up committed.
func writablePath(getenv func(string) string, override string) (string, error) {
	path := strings.TrimSpace(override)
	if path == "" {
		path = strings.TrimSpace(getenv(EnvConfig))
	}
	if path == "" {
		p, ok := writerXDGPath(getenv)
		if !ok {
			return "", &RefusedError{Reason: fmt.Sprintf(
				"neither $%s nor $%s nor $%s is set, so there is no config file to write; set one and try again",
				envXDGConfigHome, envHome, EnvConfig)}
		}
		path = p
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return "", &RefusedError{Path: path, Reason: fmt.Sprintf("the path cannot be resolved: %v", err)}
	}

	if dir, ok := repositoryRoot(abs); ok {
		return "", &RefusedError{Path: abs, Reason: fmt.Sprintf(
			"it is inside the git repository at %s, and a config file must NEVER sit in a repository: one `git add -A` and it is published. Keep it at %s, outside every repository",
			dir, xdgConfigHint)}
	}
	if !writerPathAllowed(getenv, abs) {
		return "", &RefusedError{Path: abs, Reason: fmt.Sprintf(
			"tdo writes only %s or the file named by $%s, and this file is neither; an arbitrary --config path is too easily one inside a repository",
			xdgConfigHint, EnvConfig)}
	}
	return abs, nil
}

// writerXDGPath is xdgConfigPath without the fallback to the process-wide home
// directory. See WriteOptions.Getenv for why the writer may not have one.
func writerXDGPath(getenv func(string) string) (string, bool) {
	dir := getenv(envXDGConfigHome)
	if dir == "" {
		dir = getenv(envHome)
		if dir == "" {
			return "", false
		}
		dir = filepath.Join(dir, ".config")
	}
	return filepath.Join(dir, "todocloud", "config.toml"), true
}

// writerPathAllowed is fileTokenPathAllowed for a file that may not exist yet,
// so it compares cleaned names before falling back to identity on disk.
func writerPathAllowed(getenv func(string) string, path string) bool {
	if v := strings.TrimSpace(getenv(EnvConfig)); v != "" {
		if abs, err := filepath.Abs(v); err == nil && samePath(abs, path) {
			return true
		}
	}
	if def, ok := writerXDGPath(getenv); ok && samePath(def, path) {
		return true
	}
	return false
}

// verify re-reads an edited document and checks that every setting reads back
// as the string that was asked for.
func verify(src string, settings []Setting) error {
	f, err := parseTOML(src)
	if err != nil {
		return err
	}
	for _, s := range settings {
		got, ok := f.string(s.Table, s.Key)
		if !ok {
			return fmt.Errorf("%s is missing after the edit", s.Name())
		}
		if got != s.Value {
			return fmt.Errorf("%s reads back differently after the edit", s.Name())
		}
	}
	return nil
}

// applySettings edits src, one setting at a time, and returns the new document
// together with what each setting did. Every line it was not asked about is
// copied through unchanged.
func applySettings(src string, settings []Setting) (string, []Change, error) {
	lines, trailingNewline := splitLines(src)
	changes := make([]Change, 0, len(settings))
	for _, s := range settings {
		var c Change
		var err error
		lines, c, err = applySetting(lines, s)
		if err != nil {
			return "", nil, err
		}
		changes = append(changes, c)
	}
	out := strings.Join(lines, "\n")
	if trailingNewline {
		out += "\n"
	}
	return out, changes, nil
}

// splitLines splits a document into lines, remembering whether it ended with a
// newline so that joining restores the file exactly. An empty document is
// treated as ending with one, because every file this writer produces does.
func splitLines(src string) (lines []string, trailingNewline bool) {
	if src == "" {
		return nil, true
	}
	trailingNewline = strings.HasSuffix(src, "\n")
	if trailingNewline {
		src = strings.TrimSuffix(src, "\n")
	}
	return strings.Split(src, "\n"), trailingNewline
}

// applySetting replaces, inserts or appends one key.
func applySetting(lines []string, s Setting) ([]string, Change, error) {
	rendered, err := renderString(s.Value)
	if err != nil {
		return nil, Change{}, fmt.Errorf("%s: %w", s.Name(), err)
	}

	loc := locate(lines, s.Table, s.Key)
	switch {
	case loc.keyLine >= 0:
		line := lines[loc.keyLine]
		start, end, ok := valueSpan(line, loc.eq)
		if !ok {
			return nil, Change{}, fmt.Errorf("%s: line %d could not be re-read", s.Name(), loc.keyLine+1)
		}
		previous := loc.previous
		if loc.previousOK && previous == s.Value {
			// Already exactly right. Leaving the line alone keeps whatever
			// quoting style the user chose for it.
			return lines, Change{Name: s.Name(), Value: s.Value, Previous: previous}, nil
		}
		out := make([]string, len(lines))
		copy(out, lines)
		out[loc.keyLine] = line[:start] + rendered + line[end:]
		return out, Change{Name: s.Name(), Value: s.Value, Previous: previous, Changed: true}, nil

	case loc.insertAt >= 0:
		out := insertAt(lines, loc.insertAt, s.Key+" = "+rendered)
		return out, Change{Name: s.Name(), Value: s.Value, Added: true, Changed: true}, nil

	default:
		// The table does not exist: append it, separated by a blank line from
		// whatever came before so the file stays readable.
		out := append([]string{}, lines...)
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		out = append(out, "["+s.Table+"]", s.Key+" = "+rendered)
		return out, Change{Name: s.Name(), Value: s.Value, Added: true, Changed: true}, nil
	}
}

// location says where a key is, or where it would go.
type location struct {
	// keyLine is the index of the line that sets the key, or -1.
	keyLine int
	// eq is the index of the '=' on that line.
	eq int
	// previous is the string the key already held, and previousOK says it was
	// a string at all: a key that holds an integer or a boolean is always
	// rewritten, never compared.
	previous   string
	previousOK bool
	// insertAt is where a new key belongs when the table exists but the key
	// does not, or -1 when the table does not exist either.
	insertAt int
}

// locate walks the document tracking the current table, exactly as the reader
// does, and reports where table.key is or should be written.
func locate(lines []string, table, key string) location {
	loc := location{keyLine: -1, insertAt: -1}
	inTable := table == "" // the root table is open from the first line
	// lastInTable is where a new key would go: after the last key of the
	// target table, so it joins the keys it belongs to rather than landing
	// after the comment that introduces the next table. Before the table's
	// first key, the comment and blank lines that introduce it count too, so
	// that a key added to a freshly created file lands under its header
	// comment rather than above it.
	lastInTable := -1
	seenKey := false
	if inTable {
		lastInTable = 0
	}

	for i, raw := range lines {
		text := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		if strings.HasPrefix(text, "[") {
			name, err := parseTableHeader(text, i+1)
			if err != nil {
				// The document parsed before this ran, so this cannot happen;
				// stopping is still safer than guessing at the table.
				break
			}
			if name == table {
				inTable = true
				lastInTable = i + 1
				seenKey = false
			} else {
				inTable = false
			}
			continue
		}
		if text == "" || strings.HasPrefix(text, "#") {
			if inTable && !seenKey {
				lastInTable = i + 1
			}
			continue
		}
		eq := strings.IndexByte(text, '=')
		if eq < 0 {
			continue
		}
		if !inTable {
			continue
		}
		lastInTable = i + 1
		seenKey = true
		if strings.TrimSpace(text[:eq]) != key {
			continue
		}
		// Found it. The offsets have to be in the raw line, not the trimmed
		// one, so that the original indentation survives.
		rawEq := strings.IndexByte(raw, '=')
		loc.keyLine = i
		loc.eq = rawEq
		if v, _, ok := readValue(raw, rawEq); ok {
			loc.previous = v
			loc.previousOK = isQuoted(raw, rawEq)
		}
		return loc
	}

	if lastInTable >= 0 {
		loc.insertAt = lastInTable
	}
	return loc
}

// insertAt splices a line into the document at index i.
func insertAt(lines []string, i int, line string) []string {
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:i]...)
	out = append(out, line)
	out = append(out, lines[i:]...)
	return out
}

// valueSpan returns the half-open range of the value on a key line, so that a
// replacement can keep the indentation, the key, the spacing around '=' and
// any trailing comment exactly as they were.
func valueSpan(line string, eq int) (start, end int, ok bool) {
	if eq < 0 || eq >= len(line) {
		return 0, 0, false
	}
	_, span, ok := readValue(line, eq)
	return span.start, span.end, ok
}

// span is a half-open byte range within a line.
type span struct{ start, end int }

// readValue reads the value that follows the '=' at eq, returning its decoded
// string form (empty for a non-string) and the range it occupies.
func readValue(line string, eq int) (string, span, bool) {
	if eq < 0 || eq+1 > len(line) {
		return "", span{}, false
	}
	i := eq + 1
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	start := i
	if i >= len(line) {
		return "", span{start: start, end: start}, true
	}

	if q := line[i]; q == '"' || q == '\'' {
		var b strings.Builder
		for j := i + 1; j < len(line); j++ {
			c := line[j]
			if q == '"' && c == '\\' && j+1 < len(line) {
				j++
				switch line[j] {
				case 'n':
					b.WriteByte('\n')
				case 't':
					b.WriteByte('\t')
				case 'r':
					b.WriteByte('\r')
				default:
					b.WriteByte(line[j])
				}
				continue
			}
			if c == q {
				return b.String(), span{start: start, end: j + 1}, true
			}
			b.WriteByte(c)
		}
		return "", span{}, false
	}

	// A bare value ends at a comment, and trailing spaces belong to the
	// comment's padding rather than to the value.
	end := len(line)
	if h := strings.IndexByte(line[i:], '#'); h >= 0 {
		end = i + h
	}
	for end > start && (line[end-1] == ' ' || line[end-1] == '\t' || line[end-1] == '\r') {
		end--
	}
	return "", span{start: start, end: end}, true
}

// isQuoted reports whether the value after the '=' at eq is a quoted string.
func isQuoted(line string, eq int) bool {
	for i := eq + 1; i < len(line); i++ {
		switch line[i] {
		case ' ', '\t':
		case '"', '\'':
			return true
		default:
			return false
		}
	}
	return false
}

// renderString quotes a value as a basic TOML string. Only the escapes the
// reader understands are produced, and a value holding any other control
// character is refused rather than written in a form that cannot be read back.
func renderString(v string) (string, error) {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if c < 0x20 || c == 0x7f {
				return "", fmt.Errorf("the value holds a control character (0x%02x) that this file format cannot represent", c)
			}
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String(), nil
}

// writeFileAtomic writes data to path through a temporary file in the same
// directory, renamed into place. The file is mode 0600 and the directory 0700
// whatever umask the process inherited, matching what the store does: a config
// file is not a credential, but it names where one is used.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	switch {
	case err == nil:
		// An existing directory is tightened when it is readable by group or
		// others, and otherwise left alone: a user who chose 0500 chose it,
		// and widening someone's permissions is not this function's business.
		if info.Mode().Perm()&0o077 != 0 {
			if err := os.Chmod(dir, 0o700); err != nil {
				return fmt.Errorf("securing %s: %w", dir, err)
			}
		}
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
		// MkdirAll applies the umask, so the mode is set explicitly: a
		// directory tdo creates is 0700 whatever the process inherited.
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("securing %s: %w", dir, err)
		}
	default:
		return fmt.Errorf("reading %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("creating a temporary file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() {
		// Harmless once the rename succeeded: the name is gone by then.
		_ = os.Remove(tmpName)
	}()

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("securing %s: %w", tmpName, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing %s: %w", tmpName, err)
	}
	// The rename is only atomic with respect to a crash if the contents are on
	// disk first; otherwise the user can be left with an empty file.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("writing %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("writing %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}
