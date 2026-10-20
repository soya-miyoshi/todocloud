package cli

import "testing"

// TestServeAddrDefaultsToLoopback is the rule from PLAN.md: a viewer is not a
// service, so reaching it from the network has to be asked for.
func TestServeAddrDefaultsToLoopback(t *testing.T) {
	cases := []struct {
		name string
		addr string
		port int
		want string
		bad  bool
	}{
		{name: "the default", port: defaultServePort, want: "127.0.0.1:7373"},
		{name: "a chosen port", port: 8080, want: "127.0.0.1:8080"},
		{name: "any free port", port: 0, want: "127.0.0.1:0"},
		{name: "a host of its own", addr: "0.0.0.0", port: defaultServePort, want: "0.0.0.0:7373"},
		{name: "a host and port", addr: "0.0.0.0:9000", port: defaultServePort, want: "0.0.0.0:9000"},
		{name: "an IPv6 host", addr: "::1", port: 7000, want: "[::1]:7000"},
		{name: "two answers to one question", addr: "0.0.0.0:9000", port: 8080, bad: true},
		{name: "a port that does not exist", port: 70000, bad: true},
		{name: "a negative port", port: -1, bad: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := serveAddr(c.addr, c.port)
			if c.bad {
				if err == nil {
					t.Fatalf("serveAddr(%q, %d) = %q, want an error", c.addr, c.port, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("serveAddr(%q, %d): %v", c.addr, c.port, err)
			}
			if got != c.want {
				t.Fatalf("serveAddr(%q, %d) = %q, want %q", c.addr, c.port, got, c.want)
			}
		})
	}
}

// TestExposedWarnsOnAnythingButLoopback. The warning is the only thing
// standing between a user who typed --addr 0.0.0.0 and a list their network
// can edit, so it errs towards warning.
func TestExposedWarnsOnAnythingButLoopback(t *testing.T) {
	quiet := []string{"", "127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.1:8080", "127.0.0.2"}
	loud := []string{"0.0.0.0", "::", "192.168.1.10", "0.0.0.0:9000", "example.local"}
	for _, addr := range quiet {
		if exposed(addr) {
			t.Errorf("exposed(%q) = true, want false", addr)
		}
	}
	for _, addr := range loud {
		if !exposed(addr) {
			t.Errorf("exposed(%q) = false, want true", addr)
		}
	}
}
