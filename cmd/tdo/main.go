// Command tdo keeps a todo list in a database the user owns.
//
// This file is deliberately tiny: everything the CLI does lives in
// internal/cli, which is also what the tests drive, so that nothing is only
// reachable through the real process.
package main

import (
	"context"
	"os"

	"github.com/soya-miyoshi/todocloud/internal/cli"
)

func main() {
	os.Exit(cli.Run(context.Background(), os.Args))
}
