package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `tdo doctor` is a diagnostic. A diagnostic that leaves a directory behind is
// how a mistyped path quietly becomes real, which matters most when an agent
// is running the command to find out what is wrong.
func TestDoctorCreatesNothing(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "typo", "deeper", "tasks.db")

	h := newHarness(t)
	h.env["TODOCLOUD_SQLITE_PATH"] = missing

	got := h.run("doctor", "--json")

	var report struct {
		OK     bool `json:"ok"`
		Checks []struct {
			Name   string `json:"name"`
			OK     bool   `json:"ok"`
			Detail string `json:"detail"`
		} `json:"checks"`
	}
	if err := json.Unmarshal([]byte(got.stdout), &report); err != nil {
		t.Fatalf("doctor output is not the documented report: %v\nstdout: %q", err, got.stdout)
	}

	for _, path := range []string{
		filepath.Join(dir, "typo"),
		filepath.Join(dir, "typo", "deeper"),
		missing,
	} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("doctor created %s", path)
		}
	}

	// The report must still be useful: the directory check passes, saying the
	// path is writable and that init would create it, and the store itself is
	// reported as uninitialised rather than as a mystery.
	var dirDetail, pingDetail string
	for _, c := range report.Checks {
		switch c.Name {
		case "database_directory":
			if !c.OK {
				t.Errorf("database_directory failed: %s", c.Detail)
			}
			dirDetail = c.Detail
		case "ping":
			pingDetail = c.Detail
		}
	}
	if !strings.Contains(dirDetail, "tdo init") {
		t.Errorf("database_directory detail = %q, want it to say init would create the directory", dirDetail)
	}
	if !strings.Contains(pingDetail, "init") {
		t.Errorf("ping detail = %q, want it to advise running init", pingDetail)
	}
}
