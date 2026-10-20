package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// SchemaVersion is the schema version this binary writes and expects.
//
// It is an alias for the shared constant, not a second copy of the number.
// The DDL and the migration ladder live in internal/store/schema so that the
// two providers cannot drift apart; the version has to come from the same
// place for the same reason.
const SchemaVersion = schema.Version

// metaSchemaVersion is the key under which the version lives in the meta
// table. Every provider uses the same name, so `tdo migrate` reads the same
// thing everywhere.
const metaSchemaVersion = schema.MetaKey

// Init creates the schema and records the version. It is idempotent.
func (s *Store) Init(ctx context.Context) error {
	// Init is idempotent and therefore runs against a store that already has
	// a schema — including one a newer tdo wrote. Stamping this binary's
	// version over a higher one would leave the marker lying about a schema
	// it no longer describes, and every later CheckSchema would pass while
	// the two disagreed. Refuse instead.
	switch found, err := s.SchemaVersion(ctx); {
	case err == nil && found > schema.Version:
		return &store.VersionError{Store: s.Describe(), Found: found, Want: schema.Version}
	case err != nil && !errors.Is(err, store.ErrNotInitialized):
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin init: %w", err)
	}
	defer tx.Rollback()

	for _, stmt := range schema.Initial() {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("sqlite: create schema: %w", err)
		}
	}
	if err := setVersion(ctx, tx, schema.Version); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: commit init: %w", err)
	}
	return nil
}

// SchemaVersion reports the version recorded in the store, or
// store.ErrNotInitialized when the meta table or the row is missing.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	row := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, metaSchemaVersion)
	switch err := row.Scan(&v); {
	case err == nil:
		return v, nil
	case errors.Is(err, sql.ErrNoRows):
		return 0, fmt.Errorf("sqlite: no %s row: %w", metaSchemaVersion, store.ErrNotInitialized)
	default:
		// A missing meta table lands here; it means the same thing.
		return 0, fmt.Errorf("sqlite: read %s: %w", metaSchemaVersion, store.ErrNotInitialized)
	}
}

// CheckSchema reports whether the store holds the schema this binary writes.
// It is the cheap check every command makes before it does anything else:
// one indexed read of a one-row table, and a clear error either way instead
// of a query against a schema this binary does not understand.
func (s *Store) CheckSchema(ctx context.Context) error {
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	return store.CheckVersion(v, s.Describe())
}

// Migrate upgrades the store to the current version. A store that has never
// been initialized is created from scratch, and one written by a newer
// binary is refused.
//
// The whole ladder runs in one transaction, which SQLite can do and the
// remote providers cannot, so an interrupted migration leaves the file
// exactly as it was. The version is nevertheless recorded after every step
// rather than once at the end: it costs one statement, it keeps this
// provider's ladder-running identical to the one that has no transaction to
// fall back on, and it means a step that one day has to run outside the
// transaction does not need a different resumption story.
func (s *Store) Migrate(ctx context.Context) error {
	current, err := s.SchemaVersion(ctx)
	if err != nil && !errors.Is(err, store.ErrNotInitialized) {
		return err
	}
	if errors.Is(err, store.ErrNotInitialized) {
		// Nothing to carry forward: create the current schema directly.
		return s.Init(ctx)
	}
	if current > schema.Version {
		return &store.VersionError{Store: s.Describe(), Found: current, Want: schema.Version}
	}
	if current == schema.Version {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("sqlite: begin migrate: %w", err)
	}
	defer tx.Rollback()

	for _, step := range schema.Pending(current) {
		for _, stmt := range step.Statements {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("sqlite: migration to %d (%s): %w", step.To, step.Name, err)
			}
		}
		if err := setVersion(ctx, tx, step.To); err != nil {
			return err
		}
	}
	// The ladder may be empty for a recorded version below the current one —
	// a version bumped without a rung, which the schema package's own checks
	// make hard but which tampering can still produce. Recording the target
	// after the loop means Migrate never commits while leaving the marker
	// where it was, quietly reporting success without arriving.
	if err := setVersion(ctx, tx, schema.Version); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("sqlite: commit migrate: %w", err)
	}
	return nil
}

// backupSuffix marks a file as a copy this tool made. It is spelled out
// rather than abbreviated because the one person who will ever read it is
// looking at a directory listing and wondering what happened to their tasks.
const backupSuffix = ".backup-v"

// BackupForMigration copies the database beside itself before a migration
// changes it, and returns the path of the copy. It implements
// store.Backupper, which is how `tdo migrate` knows a local store can be
// protected and a remote one cannot.
//
// The copy is made with VACUUM INTO rather than by copying bytes: the
// database runs in WAL mode, so the file alone is not the whole database,
// and a plain file copy would silently leave behind whatever is still in the
// write-ahead log. VACUUM INTO asks the engine for a consistent copy of
// everything.
//
// An existing backup is never overwritten. A migration that failed once has
// already left a copy that is the only version of that data in its old
// shape, and a second attempt must not land on top of it.
func (s *Store) BackupForMigration(ctx context.Context, from int) (string, error) {
	if s.path == MemoryPath {
		// There is no file, and an in-memory store holds nothing that
		// outlives the process anyway.
		return "", nil
	}
	path, err := s.backupPath(from)
	if err != nil {
		return "", err
	}
	// The path is built here from the store's own path and an integer, so
	// there is no user input in this statement; SQLite has no placeholder
	// for the target of VACUUM INTO.
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO `+quoteLiteral(path)); err != nil {
		return "", fmt.Errorf("sqlite: back up %s to %s: %w", s.path, path, err)
	}
	// A task list is private data and VACUUM INTO creates the file with the
	// process umask, which on most machines means world-readable.
	if err := os.Chmod(path, fileMode); err != nil {
		return "", fmt.Errorf("sqlite: securing the backup at %s: %w", path, err)
	}
	return path, nil
}

// backupPath picks a name that says both that the file is a backup and which
// schema version it holds, and that does not already exist.
func (s *Store) backupPath(from int) (string, error) {
	base := s.path + backupSuffix + fmt.Sprint(from)
	for n := 0; n < 100; n++ {
		candidate := base
		if n > 0 {
			candidate = fmt.Sprintf("%s.%d", base, n+1)
		}
		_, err := os.Stat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			return candidate, nil
		}
		if err != nil {
			return "", fmt.Errorf("sqlite: checking for a free backup name at %s: %w", filepath.Dir(s.path), err)
		}
	}
	return "", fmt.Errorf("sqlite: %s already has 100 backups; move some of them away first", base)
}

// quoteLiteral renders a path as a SQL string literal. VACUUM INTO takes no
// bound parameter, so this is the one place a value is spliced into a
// statement; a single quote in a path is doubled, which is the only escape
// SQLite string literals have.
func quoteLiteral(s string) string {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '\'')
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out = append(out, '\'')
		}
		out = append(out, s[i])
	}
	return string(append(out, '\''))
}

func setVersion(ctx context.Context, tx *sql.Tx, v int) error {
	if _, err := tx.ExecContext(ctx, schema.SetVersionSQL, metaSchemaVersion, v); err != nil {
		return fmt.Errorf("sqlite: record %s: %w", metaSchemaVersion, err)
	}
	return nil
}
