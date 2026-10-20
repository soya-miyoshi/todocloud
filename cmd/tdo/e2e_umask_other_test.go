//go:build !unix

package main

// setUmask has nothing to set on a platform without a umask.
func setUmask(int) (restore func(), ok bool) { return func() {}, false }
