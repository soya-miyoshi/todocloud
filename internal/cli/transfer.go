package cli

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/id"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/task"
)

// bom is the byte-order mark a spreadsheet may prepend to a CSV file.
const bom = "\xef\xbb\xbf"

// exportVersion is the version of the export envelope, not of the binary. It
// changes when the envelope's shape does, so that a file says which shape it
// is in rather than leaving a reader to sniff it.
const exportVersion = 1

// csvHeader is the column order of `tdo export --csv`. Every required field
// of §3.2 has a column and every user-defined field lives in the single
// trailing `fields` column, so the flexible half of the model survives a
// round trip through a spreadsheet.
var csvHeader = []string{
	task.KeyID,
	task.KeyKind,
	task.KeyTitle,
	task.KeyParentID,
	task.KeyPosition,
	task.KeyStatus,
	task.KeyFlagged,
	task.KeySequential,
	task.KeyCompletedByChildren,
	task.KeyDeferAt,
	task.KeyDueAt,
	task.KeyEstimatedMinutes,
	task.KeyNote,
	task.KeyRepeat,
	task.KeySeriesID,
	task.KeyReviewInterval,
	task.KeyLastReviewedAt,
	task.KeyCreatedAt,
	task.KeyUpdatedAt,
	task.KeyCompletedAt,
	task.KeyDroppedAt,
	task.KeyDeletedAt,
	task.KeyTags,
	"fields",
}

// csvBoolColumns and csvIntColumns say how a cell is typed on the way back
// in; everything else is a string or a JSON document.
var csvBoolColumns = map[string]bool{
	task.KeyFlagged: true, task.KeySequential: true, task.KeyCompletedByChildren: true,
}

var csvIntColumns = map[string]bool{
	task.KeyPosition: true, task.KeyEstimatedMinutes: true,
}

var csvJSONColumns = map[string]bool{
	task.KeyRepeat: true, task.KeyReviewInterval: true,
}

func (a *app) exportCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "export",
		Usage: "write every item to stdout for backup or for another provider",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "csv",
				Usage: "write CSV instead of JSON",
			},
			&ucli.BoolFlag{
				Name:  "all",
				Usage: "include the items `tdo rm` tombstoned",
			},
		},
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			if cmd.Args().Len() > 0 {
				return usagef("export takes no arguments")
			}
			// A backup is everything, whatever its status: filtering a backup
			// is how a restore quietly loses the history. --all adds the
			// tombstones, which are the only rows left out by default.
			tasks, err := st.List(ctx, store.Filter{
				IncludeDeleted: cmd.Bool("all"),
				Order:          store.OrderCreated,
			})
			if err != nil {
				return err
			}
			if tasks == nil {
				tasks = []*task.Task{}
			}
			// Export does not touch the short-number cache. Its output is
			// machine data — a JSON envelope or CSV, whether or not --json was
			// passed — so nobody reads numbers off it, and renumbering the
			// list while taking a backup would change what `tdo done 2` means
			// for whoever is reading the terminal. It generates nothing
			// either: export is a pure read (§3.4).

			// A perspective is a saved query, and §3.7 calls an export a
			// backup while §10 makes export/import the way to move a list to
			// another provider. Leaving the saved queries out of both would
			// lose them silently. Reading them is a pure read like the rest
			// of export.
			perspectives, err := st.Perspectives(ctx)
			if err != nil {
				return err
			}
			if perspectives == nil {
				perspectives = []*store.Perspective{}
			}

			if cmd.Bool("csv") {
				// CSV is a task table: a saved query has no row in it, and
				// inventing one would make the file no longer a task table.
				// The note goes to stderr, because stdout is the CSV.
				if len(perspectives) > 0 {
					a.out.Hintf("tdo: note: %d saved perspective(s) are not in a CSV export; use the JSON form to back them up", len(perspectives))
				}
				return writeCSV(a.out.Out, tasks)
			}
			// Export is machine output by nature, so it is JSON whether or
			// not --json was given.
			return a.out.Emit(map[string]any{
				"version":     exportVersion,
				"exported_at": task.FormatTime(time.Now()),
				// Where the tasks came from, so an archive read months later
				// says which store it is a copy of. It is a description, not
				// a credential: Store.Describe never returns a secret.
				"store": st.Describe(),
				"tasks": tasks,
				// count is the number of tasks and nothing else, which is
				// what `count` means beside a `tasks` array in every other
				// command's --json. A second array gets a second count
				// rather than being folded into this one.
				"count":             len(tasks),
				"perspectives":      perspectives,
				"perspective_count": len(perspectives),
			})
		}),
	}
}

// writeCSV writes the rows by marshalling each task and reading the columns
// back out of the result, so the CSV and the JSON can never disagree about
// what a field holds.
func writeCSV(w io.Writer, tasks []*task.Task) error {
	cw := csv.NewWriter(w)
	if err := cw.Write(csvHeader); err != nil {
		return err
	}
	for _, t := range tasks {
		encoded, err := json.Marshal(t)
		if err != nil {
			return fmt.Errorf("task %s: render: %w", t.ID, err)
		}
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &obj); err != nil {
			return fmt.Errorf("task %s: render: %w", t.ID, err)
		}

		fields, err := json.Marshal(t.Fields)
		if err != nil {
			return fmt.Errorf("task %s: render fields: %w", t.ID, err)
		}
		record := make([]string, 0, len(csvHeader))
		for _, column := range csvHeader {
			switch column {
			case "fields":
				record = append(record, string(fields))
			case task.KeyTags:
				record = append(record, strings.Join(t.Tags, ","))
			default:
				record = append(record, csvCell(obj[column]))
			}
		}
		if err := cw.Write(record); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

// csvCell renders one JSON value as a cell: a null is empty, a string loses
// its quotes, and anything structured keeps its JSON so the round trip is
// lossless.
func csvCell(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}

func (a *app) importCommand() *ucli.Command {
	return &ucli.Command{
		Name:      "import",
		Usage:     "add tasks from a file written by `tdo export`",
		ArgsUsage: "<file>",
		Flags: []ucli.Flag{
			&ucli.BoolFlag{
				Name:  "new-ids",
				Usage: "assign fresh ids instead of keeping the ones in the file",
			},
		},
		Action: a.storeWriteAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			args := cmd.Args().Slice()
			if len(args) != 1 {
				return usagef("import expects exactly one file")
			}
			data, err := os.ReadFile(args[0])
			if err != nil {
				return exit.Usagef(err)
			}
			file, err := decodeImport(data)
			if err != nil {
				return exit.Usagef(err)
			}
			tasks := file.Tasks

			newIDs := cmd.Bool("new-ids")

			// The whole file is checked before anything is written. An import
			// file is untrusted input, and rejecting it halfway through would
			// leave the store holding part of it with no record of which part.
			if err := prepareImport(tasks, newIDs); err != nil {
				return err
			}
			if err := preparePerspectives(file.Perspectives, time.Now().UTC()); err != nil {
				return err
			}
			// A child cannot be stored before its parent, because the store
			// checks the containment rules of §3.1 as it writes. The file's
			// own order is kept otherwise, so an export imports exactly as
			// it was taken.
			tasks = orderForImport(tasks)

			imported, skipped := 0, 0
			for _, t := range tasks {
				switch _, err := st.Get(ctx, t.ID); {
				case err == nil:
					// An id that is already there is the same task: importing
					// the same file twice must not duplicate anything.
					skipped++
					continue
				case errors.Is(err, store.ErrNotFound):
				default:
					return err
				}
				if err := treeError(st.Add(ctx, t)); err != nil {
					return err
				}
				imported++
			}

			// A perspective is restored only when its name is free. This is
			// what `import` already does with a task whose id is taken: an
			// import adds, it never overwrites. Silently replacing a saved
			// query the user is still using would be the worse failure, and
			// the count says it happened.
			savedP, skippedP := 0, 0
			for _, p := range file.Perspectives {
				switch _, err := st.Perspective(ctx, p.Name); {
				case err == nil:
					skippedP++
					continue
				case errors.Is(err, store.ErrNotFound):
				default:
					return err
				}
				if err := st.SavePerspective(ctx, p); err != nil {
					return err
				}
				savedP++
			}

			if a.out.JSON {
				return a.out.Emit(map[string]any{
					"imported": imported, "skipped": skipped,
					"perspectives_imported": savedP, "perspectives_skipped": skippedP,
				})
			}
			a.out.Printf("imported %d task(s), skipped %d\n", imported, skipped)
			if savedP+skippedP > 0 {
				a.out.Printf("imported %d perspective(s), skipped %d\n", savedP, skippedP)
			}
			return nil
		}),
	}
}

// prepareImport validates and normalises every task before the first write.
// It returns a usage error naming the offending task, so a bad file is
// rejected as a whole rather than applied up to the point where it breaks.
func prepareImport(tasks []*task.Task, newIDs bool) error {
	for i, t := range tasks {
		// A JSON null in the tasks array decodes to a nil task. Dereferencing
		// it would panic, which for an import means a stack trace on stderr
		// and a half-written store.
		if t == nil {
			return exit.Usagef(fmt.Errorf("task %d is null", i+1))
		}

		// An id has to be a real ULID. The CLI resolves references by prefix
		// and relies on ids sorting into creation order, and `tdo export` is a
		// file a user can edit by hand or a program can generate, so a made-up
		// id is rejected rather than stored. --new-ids is the way in for data
		// from another tool.
		if newIDs {
			t.ID = id.New()
		} else {
			// Base32 is case-insensitive, so a lower-cased id is a real id
			// written differently. Storing it verbatim would make it
			// unreachable, because every lookup normalises first.
			t.ID = id.Normalize(t.ID)
			if !id.Valid(t.ID) {
				return exit.Usagef(fmt.Errorf(
					"task %d has the id %q, which is not a ULID; re-run with --new-ids to assign fresh ids", i+1, t.ID))
			}
		}
		if err := t.Validate(); err != nil {
			return exit.Usagef(fmt.Errorf("task %d (%s): %w", i+1, t.ID, err))
		}
		if t.Fields == nil {
			t.Fields = task.Fields{}
		}
	}
	return nil
}

// importFile is what an import file holds: the tasks, and the saved queries
// the JSON envelope carries alongside them. The CSV form and a bare array
// have no place for a perspective, so they leave it empty.
type importFile struct {
	Tasks        []*task.Task
	Perspectives []*store.Perspective
}

// decodeImport accepts everything `tdo export` can produce: the JSON
// envelope, a bare JSON array of tasks, and the CSV form. Unknown
// user-defined fields are preserved, because every path ends in
// task.Task.UnmarshalJSON.
func decodeImport(data []byte) (importFile, error) {
	trimmed := strings.TrimLeft(strings.TrimPrefix(string(data), bom), " \t\r\n")
	if trimmed == "" {
		return importFile{}, errors.New("the file is empty")
	}

	switch trimmed[0] {
	case '[':
		var tasks []*task.Task
		if err := json.Unmarshal([]byte(trimmed), &tasks); err != nil {
			return importFile{}, fmt.Errorf("read tasks: %w", err)
		}
		return importFile{Tasks: tasks}, nil
	case '{':
		var envelope struct {
			Tasks        []*task.Task         `json:"tasks"`
			Perspectives []*store.Perspective `json:"perspectives"`
		}
		if err := json.Unmarshal([]byte(trimmed), &envelope); err != nil {
			return importFile{}, fmt.Errorf("read tasks: %w", err)
		}
		if envelope.Tasks == nil {
			return importFile{}, errors.New("no `tasks` array in the file")
		}
		return importFile{Tasks: envelope.Tasks, Perspectives: envelope.Perspectives}, nil
	default:
		tasks, err := decodeCSV(strings.NewReader(trimmed))
		if err != nil {
			return importFile{}, err
		}
		return importFile{Tasks: tasks}, nil
	}
}

// preparePerspectives validates every saved query before the first write,
// for the same reason prepareImport does it for tasks: a file rejected
// halfway through would leave the store holding part of it. It also drops a
// name repeated inside one file, keeping the first, so that one file cannot
// both create and overwrite the same perspective.
func preparePerspectives(ps []*store.Perspective, now time.Time) error {
	seen := make(map[string]bool, len(ps))
	for i, p := range ps {
		if p == nil {
			return exit.Usagef(fmt.Errorf("perspective %d is null", i+1))
		}
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" {
			return exit.Usagef(fmt.Errorf("perspective %d has no name", i+1))
		}
		// Names are compared case-insensitively everywhere else, so two
		// spellings of one name in a file are one perspective.
		key := strings.ToLower(p.Name)
		if seen[key] {
			return exit.Usagef(fmt.Errorf("perspective %d (%s) is in the file twice", i+1, p.Name))
		}
		seen[key] = true
		if err := p.Filter.Validate(); err != nil {
			return exit.Usagef(fmt.Errorf("perspective %d (%s): %w", i+1, p.Name, err))
		}
		// A hand-written file need not carry timestamps; a stored
		// perspective always has them.
		if p.UpdatedAt.IsZero() {
			p.UpdatedAt = now
		}
		if p.CreatedAt.IsZero() {
			p.CreatedAt = p.UpdatedAt
		}
	}
	return nil
}

func decodeCSV(r io.Reader) ([]*task.Task, error) {
	records, err := csv.NewReader(r).ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read csv: %w", err)
	}
	if len(records) == 0 {
		return nil, errors.New("the csv file has no header")
	}

	header := make([]string, 0, len(records[0]))
	seen := make(map[string]bool, len(records[0]))
	for _, name := range records[0] {
		name = strings.TrimSpace(name)
		header = append(header, name)
		seen[name] = true
	}
	for _, required := range []string{task.KeyID, task.KeyTitle, task.KeyCreatedAt, task.KeyUpdatedAt} {
		if !seen[required] {
			return nil, fmt.Errorf("the csv file has no %q column", required)
		}
	}

	tasks := make([]*task.Task, 0, len(records)-1)
	for lineno, record := range records[1:] {
		// Rebuilding the JSON object and handing it to the task package keeps
		// one parser for both formats, so a field imports identically either
		// way.
		obj := map[string]any{}
		for i, column := range header {
			if column == "" || i >= len(record) {
				continue
			}
			value, err := csvValue(column, record[i])
			if err != nil {
				return nil, fmt.Errorf("csv line %d: %s: %w", lineno+2, column, err)
			}
			if column == task.KeyDone {
				// The pre-GTD export carried a derived `done` column. It is
				// read so an older file still imports, and turned into the
				// status the model actually stores.
				if done, ok := value.(bool); ok && done {
					if _, taken := obj[task.KeyStatus]; !taken {
						obj[task.KeyStatus] = string(task.StatusDone)
					}
				}
				continue
			}
			if value == nil {
				continue
			}
			if column == "fields" {
				for k, v := range value.(map[string]any) {
					if _, taken := obj[k]; !taken {
						obj[k] = v
					}
				}
				continue
			}
			obj[column] = value
		}

		encoded, err := json.Marshal(obj)
		if err != nil {
			return nil, fmt.Errorf("csv line %d: %w", lineno+2, err)
		}
		var t task.Task
		if err := json.Unmarshal(encoded, &t); err != nil {
			return nil, fmt.Errorf("csv line %d: %w", lineno+2, err)
		}
		tasks = append(tasks, &t)
	}
	return tasks, nil
}

// csvValue types one cell by its column. An empty cell is absent rather than
// zero, so a column the writer left blank does not overwrite a default.
func csvValue(column, cell string) (any, error) {
	trimmed := strings.TrimSpace(cell)
	switch {
	case column == "fields":
		if trimmed == "" {
			return nil, nil
		}
		obj := map[string]any{}
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return nil, err
		}
		return obj, nil
	case column == task.KeyTags:
		tags := parseTags([]string{cell})
		if len(tags) == 0 {
			return nil, nil
		}
		return tags, nil
	case column == task.KeyDone:
		if trimmed == "" {
			return nil, nil
		}
		return strconv.ParseBool(trimmed)
	case csvBoolColumns[column]:
		if trimmed == "" {
			return nil, nil
		}
		return strconv.ParseBool(trimmed)
	case csvIntColumns[column]:
		if trimmed == "" {
			return nil, nil
		}
		return strconv.Atoi(trimmed)
	case csvJSONColumns[column]:
		if trimmed == "" {
			return nil, nil
		}
		var v any
		if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
			return nil, err
		}
		return v, nil
	default:
		if trimmed == "" {
			return nil, nil
		}
		return cell, nil
	}
}

// orderForImport puts parents before their children while keeping the file's
// order otherwise. A parent that is not in the file is left to the store,
// which refuses an unknown one.
func orderForImport(tasks []*task.Task) []*task.Task {
	// The index is by position, not by id: the same id may appear twice in
	// one file, and the duplicate must survive this far so that `import`
	// can count it as skipped rather than lose it silently.
	first := make(map[string]int, len(tasks))
	for i, t := range tasks {
		if _, taken := first[t.ID]; !taken {
			first[t.ID] = i
		}
	}
	out := make([]*task.Task, 0, len(tasks))
	placed := make([]bool, len(tasks))

	var place func(i int, seen map[int]bool)
	place = func(i int, seen map[int]bool) {
		if placed[i] || seen[i] {
			// seen guards against a parent cycle in a hand-written file:
			// the store rejects it, and this must not loop first.
			return
		}
		seen[i] = true
		if parent, ok := first[tasks[i].ParentID]; ok && tasks[i].ParentID != tasks[i].ID {
			place(parent, seen)
		}
		if placed[i] {
			return
		}
		placed[i] = true
		out = append(out, tasks[i])
	}
	for i := range tasks {
		place(i, map[int]bool{})
	}
	return out
}
