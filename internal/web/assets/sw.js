// The service worker, and it caches nothing. That is the decision, not an
// omission.
//
// The viewer is a window onto a store on another machine. Everything worth
// showing comes from a fresh /api call, and a cache in front of that is a
// cache of a list that was true a minute ago — a screen that looks exactly
// like a live one and is not. The whole project exists so that `tdo ls`, the
// browser and the phone cannot disagree about what is available; a worker
// that answers from last week's copy would be the one place they could.
//
// The shell is the tempting exception and it is refused too. The page
// carries the write token of the process that served it, so a cached page
// would hold a token a restarted server no longer honours and the first edit
// would fail with a 403 for no visible reason — on the one device nobody can
// open a devtools window on. An offline shell would render a viewer with
// nothing behind it, which is worse than the browser saying plainly that it
// could not reach the server.
//
// So there is no `caches` use here and no `respondWith` anywhere, and
// therefore no request this worker can answer from anything but the network.
// /api is not special-cased, because there is no code path that could treat
// it specially — nothing is intercepted at all.
//
// What remains is what it is for: a page with a manifest and a registered
// worker is installable, which is how this reaches a home screen.
'use strict';

// A worker one version behind is the stale shell in another form, so a new
// one takes over immediately rather than waiting for every tab to close.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Present, and deliberately inert. A fetch listener that never calls
// respondWith leaves the browser to make the request itself, which is what
// an installability check looks for without putting this file in the path of
// a single byte.
self.addEventListener('fetch', () => {});
