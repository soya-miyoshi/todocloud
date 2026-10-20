//go:build !unix

package config

import (
	"fmt"
	"runtime"
)

// FileTokensSupported reports whether a token in the config file can be used
// on this platform at all. It is false here, and that is a decision rather
// than an oversight: see fileTokenModeGuard.
const FileTokensSupported = false

// fileTokenModeGuard refuses every file token on a platform without POSIX
// file modes. Windows expresses "only the owner may read this" in an ACL, and
// Go reports the mode of such a file as 0666 whatever the ACL says — so the
// question the guard exists to ask, is this credential readable by another
// account, cannot be answered here. Loading the token anyway would mean
// dropping the one check that makes a token in a file defensible, so the
// token stays unread and the two paths that are as safe here as anywhere —
// the environment and the OS keychain — are what the warning points at.
func fileTokenModeGuard(path string) tokenGuard {
	return tokenGuard{reason: fmt.Sprintf(
		"a token in a config file is not read on %s: the owner-only check the guard requires is a POSIX file mode, which this platform does not have, so tdo cannot tell whether another account on this machine can read %s.",
		runtime.GOOS, path)}
}
