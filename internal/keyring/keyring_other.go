//go:build !darwin && !linux

package keyring

import "fmt"

// Windows has no usable CLI for this: `cmdkey` can store a credential but
// cannot print one back, so a token stored there could never be read by this
// tool. Every other platform is simply unknown. In both cases there is no
// backend, and no command may fail because of it — the environment variable
// or the config file is used instead.
func currentBackend() backend {
	return backend{name: BackendNone}
}

// ManualInstructions returns the command the user can run themselves to store
// account's token, for the platforms where Set is unsupported. It must contain
// a placeholder, never a real token.
//
// There is nothing to run here, so it explains where the token goes instead.
func ManualInstructions(account string) string {
	return fmt.Sprintf(
		"no OS keychain is available on this platform; set the %s token in the environment "+
			"or in the config file (for example TODOCLOUD_TURSO_TOKEN=%s)",
		account, Placeholder)
}
