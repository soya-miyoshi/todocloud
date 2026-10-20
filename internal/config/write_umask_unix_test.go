//go:build unix

package config

import "syscall"

// setUmask sets the process umask and returns a function restoring the
// previous value. It reports false on a platform where the umask does not
// exist. A file tdo creates must be 0600 whatever the caller's umask, so the
// test that proves it needs a permissive one.
func setUmask(mask int) (restore func(), ok bool) {
	previous := syscall.Umask(mask)
	return func() { syscall.Umask(previous) }, true
}
