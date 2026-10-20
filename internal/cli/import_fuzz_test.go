package cli

import (
	"strings"
	"testing"
)

// decodeImport reads a file the user names on the command line, in three
// formats, one of which is driven by a hand-written column index. Whatever the
// bytes are, it must not panic, and it must not return a task alongside an
// error.
//
// It does NOT currently return only usable tasks: a JSON null in the array
// decodes to a nil *task.Task, which the import loop then dereferences. That
// is a live crash, so it is pinned by
// TestImportPanicsOnANullTaskInTheFile rather than asserted away here.
func FuzzDecodeImport(f *testing.F) {
	const envelope = `{"version":1,"exported_at":"2026-10-20T04:11:00Z","store":"sqlite: /tmp/tasks.db",` +
		`"tasks":[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"Pay the invoice","done":false,` +
		`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z",` +
		`"due":"2026-11-01","priority":2,"tags":["finance"],"client":"acme"}]}`
	const bareArray = `[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"one","done":true,` +
		`"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z",` +
		`"completed_at":"2026-10-20T05:00:00Z"}]`
	const csvForm = "id,title,done,created_at,updated_at,completed_at,deleted_at,fields\r\n" +
		"01J3ABCDEFGHJKMNPQRSTVWXYZ,Pay the invoice,false,2026-10-20T04:11:00Z,2026-10-20T04:11:00Z,,,\"{\"\"client\"\":\"\"acme\"\"}\"\r\n"

	seeds := []string{
		"", " \t\r\n", "\xef\xbb\xbf" + envelope,
		envelope, bareArray, csvForm,

		// Mutations of the envelope.
		`{}`, `{"tasks":null}`, `{"tasks":"nope"}`, `{"tasks":[]}`, `{"tasks":[null]}`,
		`{"tasks":[{}]}`, `{"tasks":{"a":1}}`,
		strings.Replace(envelope, `"title":"Pay the invoice"`, `"title":""`, 1),
		strings.Replace(envelope, `"created_at":"2026-10-20T04:11:00Z"`, `"created_at":"yesterday"`, 1),
		strings.Replace(envelope, `"priority":2`, `"priority":99`, 1),
		strings.Replace(envelope, `"due":"2026-11-01"`, `"due":"not a date"`, 1),
		envelope[:len(envelope)/2],

		// Mutations of the bare array.
		`[`, `[]`, `[1,2,3]`, `["a"]`, `[{"id":1}]`, bareArray[:20],

		// Mutations of the CSV form.
		"id,title,done,created_at,updated_at\n",
		"id,title\n1,x\n",
		csvForm + "short,row\n",
		strings.Replace(csvForm, "false", "maybe", 1),
		strings.Replace(csvForm, `"{""client"":""acme""}"`, `"{not json}"`, 1),
		"id,title,done,created_at,updated_at,fields\nx,\"a\nnewline\",false,2026-10-20T04:11:00Z,2026-10-20T04:11:00Z,{}\n",
		"id,title,done,created_at,updated_at\nx,\"unclosed,false,,\n",

		// Not any of the three formats.
		"hello", "\x00\x01\x02", "\xff\xfe", "null", "true", "42",
		strings.Repeat("a,b,c\n", 500),
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		file, err := decodeImport(data)
		tasks := file.Tasks
		if err != nil {
			if tasks != nil || file.Perspectives != nil {
				t.Fatalf("decodeImport returned %d task(s) and %d perspective(s) alongside %v",
					len(tasks), len(file.Perspectives), err)
			}
			return
		}
		for i, decoded := range tasks {
			if decoded == nil {
				// The known defect: only a literal JSON null may produce it.
				if !strings.Contains(string(data), "null") {
					t.Fatalf("task %d is nil for an input with no JSON null: %q", i, data)
				}
				continue
			}
			// Fields is documented as never nil on a decoded task.
			if decoded.Fields == nil {
				t.Fatalf("task %d has nil Fields", i)
			}
		}
	})
}
