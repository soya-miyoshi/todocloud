//go:build unix

package config

import (
	"fmt"
	"os"
)

// FileTokensSupported reports whether a token in the config file can be used
// on this platform at all. It is true here: a POSIX mode says plainly who may
// read the file, so the guard in fileTokenModeGuard can be asked and answered.
const FileTokensSupported = true

// fileTokenModeGuard refuses a file a user other than the owner can read. The
// check is the whole reason a file token is allowed anywhere: a credential in
// a world-readable file is a credential every account on the machine has.
func fileTokenModeGuard(path string) tokenGuard {
	if perm, ok := filePerm(path); ok && perm&0o077 != 0 {
		return tokenGuard{reason: fmt.Sprintf(
			"the file is readable by group or others (mode %04o); run: chmod 600 %s",
			perm, path)}
	}
	return tokenGuard{allowed: true}
}

// filePerm returns the permission bits of path, and whether they could be
// read at all.
func filePerm(path string) (os.FileMode, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	return info.Mode().Perm(), true
}
