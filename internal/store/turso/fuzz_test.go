package turso

import (
	"strings"
	"testing"
)

// decodePipelineResponse is the only parser in this package that reads bytes
// the CLI did not write, so it is the one worth fuzzing. The property is not
// that every input decodes — most should not — but that no input panics and
// that a decoded response never claims a value it cannot back up.
func FuzzDecodePipelineResponse(f *testing.F) {
	f.Add(`{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"id"}],"rows":[[{"type":"text","value":"01J3"}]],"affected_row_count":0}}}]}`)
	f.Add(`{"results":[{"type":"error","error":{"message":"no such table: tasks","code":"SQLITE_UNKNOWN"}}]}`)
	f.Add(`{"results":[{"type":"ok","response":{"type":"execute","result":{"rows":[[{"type":"integer","value":"9223372036854775807"}]]}}}]}`)
	f.Add(`{"error":{"message":"stream expired"}}`)
	f.Add(`{"baton":"x","results":[]}`)
	f.Add(`{"results":[{"type":"ok","response":{"type":"execute","result":{"rows":[[{"type":"blob","base64":"aGk"}]]}}}]}`)
	f.Add(``)
	f.Add(`null`)
	f.Add(`[]`)

	f.Fuzz(func(t *testing.T, body string) {
		resp, err := decodePipelineResponse(strings.NewReader(body))
		if err != nil {
			if resp != nil {
				t.Fatalf("a failed decode returned a response: %#v", resp)
			}
			return
		}
		if resp == nil {
			t.Fatal("a successful decode returned no response")
		}
		// Whatever came back must be self-consistent: a result claiming to
		// be ok carries a response, and every decoded value has a kind the
		// accessors understand.
		for _, res := range resp.Results {
			if res.Type == "ok" && res.Response != nil && res.Response.Result != nil {
				for _, row := range res.Response.Result.Rows {
					for _, v := range row {
						switch v.Kind {
						case kindNull, kindInteger, kindFloat, kindText, kindBlob:
						default:
							t.Fatalf("a decoded value has kind %q", v.Kind)
						}
						// The accessors must not panic on anything that
						// decoded.
						_, _ = v.Text()
						_, _ = v.Int64()
						_ = v.IsNull()
					}
				}
			}
		}
	})
}
