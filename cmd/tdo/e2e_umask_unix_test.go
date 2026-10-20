//go:build unix

package main

import "syscall"

// setUmask sets the process umask and returns a function restoring the
// previous value. It reports false on a platform where the umask does not
// exist.
func setUmask(mask int) (restore func(), ok bool) {
	previous := syscall.Umask(mask)
	return func() { syscall.Umask(previous) }, true
}
