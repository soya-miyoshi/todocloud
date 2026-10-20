# A personal iPhone client

**Status: a plan, not a commitment.** Nothing here is built. This document
exists so the decisions are made once, in the open, before any Swift is
written. It is the iOS counterpart of `PLAN.md`; everything it describes is
subject to the same rules (`CLAUDE.md`), in particular §1 on credentials.

## 1. What it is, and what it is not

A SwiftUI app for one person's own iPhone, giving the OmniFocus-shaped view
of the same list `tdo` and `tdo serve` already show. It is **not** going to
the App Store, so there is no account system, no analytics, no push service
and no server of ours anywhere in the picture: the phone talks to the user's
own Turso database, exactly as the CLI does.

Three properties follow from that, and they are the whole design:

- **The database is the user's.** The app holds a libSQL URL and a
  per-database token and nothing else. Signing in means pasting those two
  values, or scanning them from the desktop.
- **The GTD rules are not reimplemented.** Availability (§3.3), auto-completion
  with the last child (§3.3a), repetition and series (§3.4) and review (§3.5)
  are subtle enough that a second implementation in Swift would be a second
  set of bugs. The Go logic layer ships to the phone (§3 below).
- **Distribution is sideloading.** No App Store review, so no App Store
  constraints — but also no App Store convenience; §6 is honest about the
  cost.

## 1.1 First, the version with no app in it

`tdo serve` is a progressive web app (`PLAN.md` §8.2). On a phone, *Add to
Home Screen* gives it an icon and a full screen, and behind `tailscale serve`
it is reachable from anywhere the phone has signal, over the tailnet's own
HTTPS, without exposing anything to the open internet:

```sh
tailscale serve --bg 7373      # on the machine running `tdo serve`
```

That is the same logic layer, the same availability rules and the same list,
for the cost of two commands and no Apple account. **Try this before building
anything below.**

What it does not give you is the two things a native app is actually for:

- **Offline.** The installed viewer is a window: it caches nothing on
  purpose, so out of range it does not load. A native app with a local
  mirror keeps working on the train.
- **System integration.** The share sheet, a Home Screen quick action, a
  widget, Shortcuts. A web app on iOS reaches none of them.

If neither of those turns out to matter in practice, stop here — the rest of
this document is a cost nobody has to pay.

## 2. Repository layout

The app lives in this repository, under `ios/`, not in a repository of its
own. The reason is purely that it binds the Go code: a change to
`internal/taskops` and the Swift that consumes it should be one commit and
one CI run, and a `go.mod` replace directive across repositories to get that
is worse than a directory.

```
ios/
  TodoCloud.xcodeproj/        # or an XcodeGen / Tuist manifest, see §7
  TodoCloud/                  # SwiftUI sources
  Frameworks/Tdokit.xcframework   # built artifact, gitignored
mobile/                       # Go: the gomobile-exported package
```

`mobile/` is a Go package in this module. It must not be imported by anything
under `cmd/` or `internal/cli`, so a desktop build never pulls in the binding
machinery.

## 3. The bridge: one Go package, JSON in, JSON out

`gomobile bind -target=ios` exports a restricted Go API — strings, integers,
byte slices, errors, and interfaces over those — so exporting `store.Store` or
`[]*task.Task` directly is not possible. That restriction is a gift here,
because the project already has a stable machine surface: the `--json` shapes
documented in `docs/agents.md`, produced by `internal/output`.

So `mobile` exposes approximately this, and nothing more:

```go
package mobile

// Session is one opened store. Created by Open, closed by Close.
type Session struct{ /* store.Store + a mutex */ }

// Open connects to a Turso database. The token never leaves this process
// in readable form: it is held in a secret.Secret, as everywhere else.
func Open(url, token string) (*Session, error)

// Call runs one request and returns one JSON document. The request names an
// operation and carries its arguments; the response is the same envelope the
// CLI emits under --json, including the error envelope.
func (s *Session) Call(requestJSON string) (string, error)

func (s *Session) Close() error
```

Operations are the ones `internal/web` already needs — `state`, `create`,
`edit`, `done`, `status`, `flag`, `date`, `move`, `remove` — and they are
implemented by calling `internal/taskops`, not by copying it. In practice
`internal/web/api.go` and `mobile` become two transports over one handler
set; if that duplication gets uncomfortable, the handler bodies move to a
shared package and both call it. The CLI, the browser viewer and the phone
then have one definition of what "complete this task" means, which was the
point.

Consequences to accept:

- `gomobile` needs cgo for the binding itself. This does **not** weaken
  `CLAUDE.md` §3: `CGO_ENABLED=0` must keep working for the six desktop
  targets, and it will, because `mobile/` is only built by the iOS job.
  `modernc.org/sqlite` stays pure Go and is not even reached — the phone
  speaks to Turso over HTTP.
- `gomobile` is maintained but quiet, and has needed fixes for each recent
  Xcode. The first task of the milestone is a spike: bind an empty package,
  build it in CI, open it from Swift. If that spike is painful, the fallback
  is §3.1.
- Every call crosses the bridge as a string. Fine at this scale (a personal
  list is thousands of rows, not millions); if a listing ever gets slow, the
  fix is fewer, larger calls, not a chattier bridge.

### 3.1 Fallback if gomobile does not hold

Write a Swift libSQL client against the same `/v2/pipeline` HTTP API the Go
Turso provider uses, and reimplement §3.3–§3.5 in Swift. This is the honest
cost of the fallback: a second implementation of the rules, kept in step by
porting `internal/store/storetest` to XCTest. Take it only if the spike
fails, and record why.

## 4. Signing in

A sheet with two fields and a Save button:

- **Database URL** — `libsql://example.turso.io`, validated for scheme and
  host before anything is stored.
- **Database token** — a `SecureField`. Pasting is the expected input; typing
  it is not realistic.

The token goes to the iOS Keychain under
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, with the iCloud Keychain sync
attribute off. It is never written to `UserDefaults`, never into a file in the
app container, never into a log line, and never into a crash report — there is
no crash reporter. The in-memory copy is `Secret`-equivalent: a wrapper whose
`description` is `[REDACTED]`, so it cannot reach a `print` by accident. The
settings screen shows the last four characters at most, matching `tdo config`.

Two conveniences, both optional and both later:

- **QR handoff from the desktop.** `tdo` could render the URL (and only the
  URL) as a QR code, leaving the token to a paste. Showing a token as a QR
  code puts it on a screen and in any screenshot, so the default is URL only;
  a `--with-token` form would need its own argument and is probably not worth
  it.
- **Read-only mode** if the user supplies a read-only Turso token. The app
  detects the write failure and says so plainly rather than looking broken.

Turso tokens are per-database (`PLAN.md` §2), which is exactly why this is
tolerable on a phone that can be lost. The app must say, on the sign-in
screen, what the token it is being given can reach.

## 5. The app itself

**v1 is online-only** — and if that is all it is, it has no advantage over
the installed web app of §1.1, so an app that never gets its mirror is an app
that was not worth writing. Every screen is a `state` call; every edit is a call
followed by a refresh, the same discipline `internal/web/app.js` follows. No
local model means no sync bugs in v1, and on a phone that is mostly in
signal it is usable. The honest cost: the Tokyo-to-Turso round trip on every
keystroke-free action, and a useless app in the subway.

Screens, in build order:

1. **Perspectives list** — Inbox, Next, Flagged, Due, Blocked, Review, All,
   Completed, plus the user's stored perspectives (§3.6). Same set as the
   browser viewer, from the same `state` payload.
2. **Item list** — grouped by project, swipe-to-complete (with the repeat
   successor reported in the toast when one appears), swipe-to-flag.
3. **Inspector** — title, note, project, tags, defer, due, estimate,
   priority, repeat. A `Form`, not a reinvention of one.
4. **Quick capture** — the thing a phone is actually for. A single field,
   straight to the inbox, reachable from a Home Screen quick action and the
   share sheet.

**v2, if v1 earns it:** an on-device SQLite mirror and a sync pass. The design
is already decided by `PLAN.md`: last-write-wins on `updated_at`, tombstones
for deletes. The mirror makes the app work offline and makes every list
instant; it also introduces the only genuinely hard problem in this document,
which is why it is not in v1.

**Deliberately not built:** reminders and notifications (they would need
either a server or a defensible local-notification story for repeating
items), widgets, Shortcuts actions, watchOS, iPad-specific layout. Each is a
small addition later; none belongs in a first version.

## 6. Getting it onto the phone

This is the part with no good answer, so here are the three real ones.

| Path | Cost | Expiry | Install from GitHub |
|---|---|---|---|
| **Free Apple ID + SideStore/AltStore** | ¥0 | 7 days, needs refreshing | yes, an unsigned `.ipa` from Releases |
| **Apple Developer Program, ad-hoc** | $99/yr | 1 year | yes, `.ipa` + an `itms-services` manifest |
| **Apple Developer Program, TestFlight** | $99/yr | 90 days per build | no — installs from TestFlight |

**Recommended: the $99 Developer Program, ad-hoc.** For an app used every
day, a seven-day expiry is a chore that will eventually lose an inbox item.
With a paid account the build is signed for one registered device, the
`.ipa` goes to a GitHub Release, and a tiny `manifest.plist` on GitHub Pages
makes an `itms-services://` link that installs it from Safari in one tap. One
year between renewals, no desktop in the loop.

**Start with: free Apple ID + SideStore**, because it costs nothing and
proves the app before the account is bought. Note the moving parts — it needs
a pairing file made once from a computer, and an on-device tunnel app whose
recommended choice has changed more than once — so treat the setup as a
one-off cost and check SideStore's own documentation rather than this
paragraph for the current tunnel.

**TestFlight** is listed for completeness. It is the smoothest install of the
three and needs no UDID registration, but every build goes through Apple and
expires in 90 days, and a personal tool gains nothing from the round trip.

### 6.1 CI

A GitHub Actions job on `macos-latest`:

1. `gomobile bind -target=ios -o ios/Frameworks/Tdokit.xcframework ./mobile`
2. `xcodebuild archive` + `-exportArchive` with the chosen signing method
3. attach the `.ipa` to the release

Signing certificates and the provisioning profile are repository secrets,
imported into a temporary keychain that the job deletes. They are
credentials: `CLAUDE.md` §1 applies to them exactly as it does to a Turso
token, and in particular **no `.p12`, `.mobileprovision` or `.cer` file is
ever committed**, not even an expired one. Add those extensions to
`.gitignore` and to `scripts/scan-secrets.sh` before the job is written.

An unsigned build (for the SideStore path) needs no secrets at all and can
run on every push; the signed build runs on tags only.

## 7. Open questions

- **Xcode project in git, or generated?** A `.xcodeproj` is a merge-conflict
  machine, but XcodeGen/Tuist is another tool to install. Leaning: commit the
  `.xcodeproj` and keep it boring, since there is one developer.
- **Is the `mobile` handler set shared with `internal/web`, or parallel to
  it?** Parallel first, shared the moment the second copy of a rule appears.
- **Minimum iOS version.** Whatever the user's phone runs; pick the newest
  that is true, to keep the SwiftUI to one dialect.
- **Does the CLI gain anything?** A `tdo qr` for the handoff in §4 is the only
  candidate, and it is a new top-level command, so it needs asking for first.
- **v2's sync** deserves its own section here before any of it is written.
