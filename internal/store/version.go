package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/soya-miyoshi/todocloud/internal/store/schema"
)

// ErrSchemaMismatch is returned when the store's schema version is not the
// one this binary writes. It is a configuration problem, exit 3, and the
// message always says what to do about it: migrate the store when it is
// older, upgrade the binary when it is newer.
//
// It exists as a sentinel so that the command layer can branch without
// parsing prose and so that no raw SQL error ever reaches the user in its
// place: a binary that ran a query against a schema it does not understand
// would at best fail oddly and at worst answer wrongly.
var ErrSchemaMismatch = errors.New("the store's schema version is not the one this tdo expects")

// VersionError is the detail behind ErrSchemaMismatch.
type VersionError struct {
	// Store is the provider's own description of where the data is. It is
	// credential-free: it is whatever Describe returns.
	Store string
	// Found is the version recorded in the store, Want the one this binary
	// writes.
	Found int
	Want  int
}

// Older reports whether the store is behind the binary, which is the case
// `tdo migrate` fixes.
func (e *VersionError) Older() bool { return e.Found < e.Want }

func (e *VersionError) Error() string {
	if e.Older() {
		return fmt.Sprintf("%s is at schema version %d and this tdo expects %d; run `tdo migrate` to upgrade it", e.Store, e.Found, e.Want)
	}
	return fmt.Sprintf("%s is at schema version %d and this tdo only understands %d; upgrade tdo", e.Store, e.Found, e.Want)
}

// Is makes errors.Is(err, ErrSchemaMismatch) true for every VersionError.
func (e *VersionError) Is(target error) bool { return target == ErrSchemaMismatch }

// CheckVersion compares a version read from a store with the one this binary
// writes and returns a VersionError when they differ.
func CheckVersion(found int, describe string) error {
	if found == schema.Version {
		return nil
	}
	return &VersionError{Store: describe, Found: found, Want: schema.Version}
}

// VersionChecker is implemented by a provider that can answer "is this store
// the version I expect?" without paying for a round trip — because it
// already asked, or because asking is free.
//
// It is an optional interface rather than a method on Store so that adding
// it breaks no provider that has not been taught it yet; CheckSchema falls
// back to SchemaVersion.
type VersionChecker interface {
	CheckSchema(ctx context.Context) error
}

// CheckSchema verifies that s holds the schema this binary writes.
//
// This is the seam every command uses. It returns ErrNotInitialized for a
// store with no schema (exit 3, "run `tdo init`"), ErrSchemaMismatch for one
// at the wrong version (exit 3, with the right advice either way), and nil
// when the store can be used. A command that skips it can return a wrong
// answer against a schema it does not understand, which is worse than an
// error.
//
// It is cheap: a provider that already knows the version answers from what
// it has. For turso that is the probe OpenExisting makes, so a checked
// command costs exactly the round trips an unchecked one did.
func CheckSchema(ctx context.Context, s Store) error {
	if vc, ok := s.(VersionChecker); ok {
		return vc.CheckSchema(ctx)
	}
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	return CheckVersion(v, s.Describe())
}

// Backupper is implemented by a provider that can copy the data aside before
// a migration changes it. A provider that cannot — anything remote — simply
// does not implement it, and PlanMigration then reports that there will be
// no backup.
type Backupper interface {
	// BackupForMigration copies the store as it is now and returns the path
	// of the copy. from is the version being left, so that the name says
	// which schema the copy holds.
	BackupForMigration(ctx context.Context, from int) (string, error)
}

// MigrationPlan is what the command layer needs to know before it runs a
// migration: what will happen, what was saved first, and whether it has to
// ask the user.
type MigrationPlan struct {
	// Store is the provider's credential-free description of itself.
	Store string
	// From is the version recorded now; To is the version Migrate will
	// reach. From is 0 when the store holds no schema at all, in which case
	// Migrate creates one.
	From int
	To   int
	// UpToDate is true when there is nothing to do.
	UpToDate bool
	// Steps names the migrations that will run, in order, for a command
	// that wants to say what it is about to do.
	Steps []string
	// BackupPath is where the data was copied before anything changed. It
	// is empty when no backup was taken, and a command that got one should
	// print it: a user who is told where the copy is can undo the migration
	// themselves.
	BackupPath string
	// Confirm is true when no backup could be taken, which is the case for
	// every remote store. The command layer must then get an explicit yes
	// before calling Migrate, and must refuse rather than prompt when stdin
	// is not a terminal — the same rule `tdo rm --purge` follows.
	Confirm bool
	// Warning is the sentence to show the user when Confirm is true. It
	// names the store and says plainly that there is no backup.
	Warning string
}

// PlanMigration reads the store's version, refuses one written by a newer
// binary, and — for a provider that can — takes the backup, before any step
// runs. The command layer calls it, shows the user what it says, and then
// calls Migrate.
//
// The backup is taken here, not inside Migrate, so that the path can be
// printed before the risky part starts: a user watching a migration fail
// should already have been told where the copy is.
func PlanMigration(ctx context.Context, s Store) (MigrationPlan, error) {
	plan := MigrationPlan{Store: s.Describe(), To: schema.Version}

	current, err := s.SchemaVersion(ctx)
	initialized := err == nil
	switch {
	case err == nil:
	case errors.Is(err, ErrNotInitialized):
		// A store with no schema is not a migration; Migrate creates one.
		current = 0
	default:
		return plan, err
	}
	plan.From = current

	if current > schema.Version {
		return plan, &VersionError{Store: plan.Store, Found: current, Want: schema.Version}
	}
	if current == schema.Version {
		plan.UpToDate = true
		return plan, nil
	}
	for _, step := range schema.Pending(current) {
		plan.Steps = append(plan.Steps, step.Name)
	}

	// An uninitialized store holds nothing to lose, so neither the backup
	// nor the confirmation applies to it. The test is whether there was a
	// schema to read, not whether the version came back as zero: a store
	// that somehow recorded version 0 still has rows in it.
	if !initialized {
		return plan, nil
	}

	b, ok := s.(Backupper)
	if !ok {
		plan.Confirm = true
		plan.Warning = fmt.Sprintf("%s is remote: tdo cannot take a backup of it, and a migration cannot be undone. Take your provider's own snapshot first if you want one.", plan.Store)
		return plan, nil
	}
	path, err := b.BackupForMigration(ctx, current)
	if err != nil {
		return plan, err
	}
	plan.BackupPath = path
	return plan, nil
}
