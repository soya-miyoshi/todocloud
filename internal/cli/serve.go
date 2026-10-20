package cli

import (
	"context"
	"fmt"
	"net"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	ucli "github.com/urfave/cli/v3"

	"github.com/soya-miyoshi/todocloud/internal/exit"
	"github.com/soya-miyoshi/todocloud/internal/store"
	"github.com/soya-miyoshi/todocloud/internal/web"
)

// defaultServePort is the port `tdo serve` takes when none is given. It is
// in the unassigned range and unlikely to collide with a development server
// the user already has running.
const defaultServePort = 7373

// loopback is the default host. Serving only to this machine is the whole
// difference between a viewer and a service: the project has no backend
// (PLAN.md §1), and a listener anyone can reach would be one.
const loopback = "127.0.0.1"

func (a *app) serveCommand() *ucli.Command {
	return &ucli.Command{
		Name:  "serve",
		Usage: "serve a browser viewer for this store on a local port",
		Description: "The viewer reads and writes through the same store the " +
			"commands do. It listens on 127.0.0.1 unless --addr says otherwise, " +
			"and writes require a token minted at startup and handed to the page, " +
			"so another site open in the same browser cannot change your list.",
		Flags: []ucli.Flag{
			&ucli.IntFlag{
				Name:  "port",
				Value: defaultServePort,
				Usage: "listen on `PORT`; 0 picks a free one and prints it",
			},
			&ucli.StringFlag{
				Name:  "addr",
				Usage: "listen on `ADDR` instead of 127.0.0.1, for example 0.0.0.0 to reach it from the network",
			},
		},
		Action: a.storeAction(func(ctx context.Context, cmd *ucli.Command, st store.Store) error {
			if cmd.Args().Len() > 0 {
				return usagef("serve takes no arguments; pass --port or --addr")
			}
			addr, err := serveAddr(cmd.String("addr"), cmd.Int("port"))
			if err != nil {
				return err
			}
			return a.serve(ctx, st, addr, exposed(cmd.String("addr")))
		}),
	}
}

// serveAddr builds the listen address from --addr and --port. A host:port in
// --addr carries its own port, so passing --port as well would be two
// answers to one question.
func serveAddr(addr string, port int) (string, error) {
	if port < 0 || port > 65535 {
		return "", usagef("--port must be between 0 and 65535, got %d", port)
	}
	host := strings.TrimSpace(addr)
	if host == "" {
		return net.JoinHostPort(loopback, strconv.Itoa(port)), nil
	}
	if h, p, err := net.SplitHostPort(host); err == nil {
		if p != "" && port != defaultServePort {
			return "", usagef("--addr already names port %s; drop --port", p)
		}
		return net.JoinHostPort(h, p), nil
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// exposed reports whether --addr asks for a listener this machine is not the
// only one that can reach. It is used for the warning, not for a refusal:
// the user asked, and PLAN.md's rule is that the default is loopback, not
// that the network is forbidden.
func exposed(addr string) bool {
	host := strings.TrimSpace(addr)
	if host == "" {
		return false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	switch host {
	case "", loopback, "localhost", "::1", "[::1]":
		return false
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return !ip.IsLoopback()
	}
	// A name this package cannot resolve to a loopback address is treated as
	// reachable, because the warning costs the user a line and the silence
	// could cost them their list.
	return true
}

func (a *app) serve(ctx context.Context, st store.Store, addr string, exposed bool) error {
	srv, err := web.New(st)
	if err != nil {
		return err
	}
	ln, err := web.Listen(addr)
	if err != nil {
		// A port already in use is the common case here, and it is the
		// user's to fix with --port rather than a provider failure.
		return exit.Usagef(fmt.Errorf("could not listen on %s: %w", addr, err))
	}
	defer ln.Close()

	url := fmt.Sprintf("http://%s/", ln.Addr().String())
	if a.out.JSON {
		// One object, written as soon as the listener is up, so a script can
		// learn the port that was chosen before the first request.
		if err := a.out.Emit(map[string]any{"url": url, "addr": ln.Addr().String(), "store": st.Describe()}); err != nil {
			return err
		}
	} else {
		a.out.Printf("%s\n", url)
	}
	a.out.Warnf("serving %s; press Ctrl-C to stop", st.Describe())
	if exposed {
		a.out.Warnf("this listener is reachable from the network: anyone who can load the page can change this list")
	}

	// Ctrl-C stops the listener rather than the process, so the store is
	// closed the way every other command closes it.
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.Serve(ctx, ln)
}
