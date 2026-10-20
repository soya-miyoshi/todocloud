package turso

import (
	"context"
	"errors"
	"fmt"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// SchemaVersion is the schema version this binary writes and expects.
//
// It is the shared constant, not a second copy of the number: the two stores
// hold the same schema, `tdo export | tdo import` moves tasks between them,
// and a version that drifted apart would make one of the two silently wrong
// about which migrations it owes. The DDL and the ladder come from the same
// package for the same reason.
const SchemaVersion = schema.Version

// metaSchemaVersion is the key the version lives under in the meta table.
// Every provider uses the same name, so `tdo migrate` reads the same thing
// everywhere.
const metaSchemaVersion = schema.MetaKey

// Init creates the schema and records the version. It is idempotent.
//
// Every statement goes up in one pipeline, so `tdo init` against a remote
// database is a single round trip. They are deliberately all idempotent —
// CREATE ... IF NOT EXISTS, and an upsert for the version — rather than
// wrapped in a transaction: the pipeline reports each statement's outcome
// separately, and a half-applied idempotent schema is repaired by running
// `tdo init` again, whereas a COMMIT that was queued behind a failed
// statement would not be.
func (s *Store) Init(ctx context.Context) error {
	if s.client == nil {
		return errClosed
	}
	// Init is idempotent and therefore runs against a store that already has
	// a schema — including one a newer tdo wrote. Stamping this binary's
	// version over a higher one would leave the marker lying about a schema
	// it no longer describes, and every later CheckSchema would pass while
	// the two disagreed. Refuse instead.
	switch found, err := s.SchemaVersion(ctx); {
	case err == nil && found > schema.Version:
		return exit.Configf(&store.VersionError{Store: s.Describe(), Found: found, Want: schema.Version})
	case err != nil && !errors.Is(err, store.ErrNotInitialized):
		return err
	}

	var b batch
	for _, q := range schema.Initial() {
		b.add(q, false)
	}
	b.add(schema.SetVersionSQL, false, metaSchemaVersion, schema.Version)
	if _, err := s.send(ctx, &b); err != nil {
		return s.wrapSchema(err, "create schema")
	}
	s.rememberVersion(schema.Version)
	return nil
}

// SchemaVersion reports the version recorded in the store, or
// store.ErrNotInitialized when the meta table or the row is missing.
func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	const q = `SELECT value FROM meta WHERE key = ?`
	res, err := s.exec(ctx, q, true, metaSchemaVersion)
	if err != nil {
		if missingTable(err) {
			// A database with no meta table is a database with no schema.
			return 0, fmt.Errorf("turso: %s: %w", s.database, store.ErrNotInitialized)
		}
		return 0, s.wrap(err, "read "+metaSchemaVersion)
	}
	if len(res.Rows) == 0 || len(res.Rows[0]) == 0 {
		return 0, fmt.Errorf("turso: no %s row: %w", metaSchemaVersion, store.ErrNotInitialized)
	}
	v, ok := res.Rows[0][0].Int64()
	if !ok {
		// A meta table holding something that is not a version is not a
		// store this binary wrote; that means the same thing as no schema.
		return 0, fmt.Errorf("turso: %s is not a version: %w", metaSchemaVersion, store.ErrNotInitialized)
	}
	s.rememberVersion(int(v))
	return int(v), nil
}

// rememberVersion records what the last read or write of the meta row saw,
// so that CheckSchema can answer without a second round trip.
func (s *Store) rememberVersion(v int) {
	s.version, s.versionKnown = v, true
}

// CheckSchema reports whether the store holds the schema this binary writes.
//
// It is the check every command makes before it does anything else, and for
// this provider it is free: OpenExisting already reads the meta row to prove
// the database is initialized, so the version is in hand before the command
// asks. Only a store opened with Open (which `tdo init` uses, and which
// makes no request) pays for a round trip here.
//
// The cached value is the version this process has been working against. A
// migration run by another process while this one is mid-command would not
// be noticed, and that is the right trade: the alternative is a round trip
// per command to close a window that a single CLI invocation barely has.
func (s *Store) CheckSchema(ctx context.Context) error {
	if !s.versionKnown {
		if _, err := s.SchemaVersion(ctx); err != nil {
			return err
		}
	}
	return store.CheckVersion(s.version, s.Describe())
}

// Migrate upgrades the store to the current version. A store that has never
// been initialized is created from scratch, and one written by a newer
// binary is refused rather than guessed at.
//
// Each step is its own pair of round trips: one pipeline that runs the
// step's statements, and — only once every one of them has come back ok — a
// second that records the new version. The two cannot be combined. There is
// no transaction over the pipeline and the server keeps executing after a
// statement fails, so a version write sent in the same pipeline would land
// even though the step it claims to have finished did not.
//
// Recording the version per step is what makes an interrupted migration
// recoverable on a store nobody can restore from a backup: whatever happens,
// the meta row names a version the store has actually reached, and the next
// `tdo migrate` picks up from there. The price is that a step may run twice
// — a crash between the statements and the version write leaves the store
// looking like it still owes that step — which is why every step must be
// idempotent (see schema.Step).
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
		return exit.Configf(&store.VersionError{Store: s.Describe(), Found: current, Want: schema.Version})
	}
	if current == schema.Version {
		return nil
	}

	for _, step := range schema.Pending(current) {
		var b batch
		for _, q := range step.Statements {
			b.add(q, false)
		}
		if _, err := s.send(ctx, &b); err != nil {
			return s.wrapSchema(err, fmt.Sprintf("migration to %d (%s)", step.To, step.Name))
		}
		var mark batch
		mark.add(schema.SetVersionSQL, false, metaSchemaVersion, step.To)
		if _, err := s.send(ctx, &mark); err != nil {
			return s.wrapSchema(err, fmt.Sprintf("recording version %d", step.To))
		}
		s.rememberVersion(step.To)
	}
	// The ladder may be empty for a recorded version below the current one —
	// a version bumped without a rung, which the schema package's own checks
	// make hard but which tampering can still produce. Recording the target
	// afterwards means Migrate never returns success while leaving the marker
	// where it was. It is a second write rather than part of the last step's
	// batch for the same reason the per-step marker is: a pipeline keeps
	// executing after a failed statement, so a version must only be written
	// once the work it names has come back ok.
	var final batch
	final.add(schema.SetVersionSQL, false, metaSchemaVersion, schema.Version)
	if _, err := s.send(ctx, &final); err != nil {
		return s.wrapSchema(err, fmt.Sprintf("recording version %d", schema.Version))
	}
	s.rememberVersion(schema.Version)
	return nil
}

// wrapSchema reports a failed Init or Migrate. Unlike the task methods it
// does not translate a missing table into ErrNotInitialized: these are the
// two commands whose job is to create one, so "no such table" here is a real
// failure and not advice to run `tdo init`.
func (s *Store) wrapSchema(err error, what string) error {
	if err == nil {
		return nil
	}
	var remote *remoteError
	if errors.As(err, &remote) {
		return exit.Providerf(fmt.Errorf("turso: %s: %w", what, err))
	}
	return fmt.Errorf("turso: %s: %w", what, err)
}
