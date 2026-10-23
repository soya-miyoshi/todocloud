# The browser viewer

`tdo serve` serves the viewer for your list on a local port; the
[README](../README.md) has the overview and the sidebar's keys. Things worth
knowing:

- **It installs on a phone.** The page is a progressive web app: open it from
  your phone and use the browser's *Add to Home Screen* to get a full-screen
  viewer with an icon. It is a window onto the machine running `tdo serve`,
  not a copy of your list: nothing is cached, so there is no offline mode and
  nothing stale to mistake for the truth. Out of range it is simply a page
  that cannot load.

- **It is built for the phone it installs on.** It opens on the Forecast — a
  week of day columns, today first and carrying whatever is already overdue —
  and shows one pane at a time. The back chevron, your phone's own back
  gesture and a swipe across the pane all mean the same thing, and the address
  says where you are (`/forecast/d3`, `/project/<id>`, `…/item/<id>`), so a
  link opens what it names. Search is the box at the top of the list; capture
  is the Add button at the bottom, which opens a form with the dates and the
  project on it. Long titles wrap rather than being cut, and where the browser
  allows it the icon carries a badge: how many tasks are due today or are
  already late.
- **Events are there too.** An event is something you are waiting for (a
  reply, a delivery); `tdo event` makes them. The *Events* tile, above Review,
  lists what is pending; the ones that occurred stay out of it until *Show
  occurred* (or the Events section of the settings page) turns them on, and
  then they sit under their own caption. The settings page also has *Count
  blocked tasks in the calendar*, which decides whether the week's day
  numbers (and the day each one opens) include tasks that are waiting on
  something. and a project's own view lists a project's own view lists the events that belong to it — filed there, or waited for by one of its tasks, even after they occurred — above its tasks; in the sidebar's Projects list, a project that is open shows them (marked ◷, with how many items wait for each) before its tasks.
  Tapping a row opens the event in the inspector — its full title, note,
  expected date, project and the items waiting for it, all editable except the
  waiting items — and the circle on a row, or the button there, says it
  occurred. The circle is a toggle, so tapping the wrong one is undone by
  tapping it again; the waiting items are released and held again with it, and
  the page says which. An item waiting for an event says so in its inspector.
  Making an event, and choosing what waits for it, stay with `tdo event`.
- It listens on `127.0.0.1`. `tdo serve --addr 0.0.0.0` makes it reachable
  from your network, and says so when you do — anyone who can load the page
  can edit the list.
- Writes carry a token minted when the server starts and handed to the page,
  so another site open in the same browser cannot change your list. Restarting
  the server invalidates it; reload the page.
- Reaching it from a phone means exposing it beyond loopback. The safe way is
  a private network rather than the open one: with
  [Tailscale](https://tailscale.com), `tailscale serve --bg 7373` puts it
  behind your tailnet's own HTTPS name, visible to your devices only — and
  the `https://` is also what makes it installable on Android, since a
  browser only accepts a service worker over TLS or loopback. Both MagicDNS and HTTPS
  certificates have to be on for your tailnet
  ([admin console → DNS](https://login.tailscale.com/admin/dns)); without
  them there is no name to serve under and the command hangs rather than
  saying so.

There is no purge button. `tdo rm --purge` stays at the terminal, where it can
ask you first.
