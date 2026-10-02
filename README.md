# Volocity

A browser extension for Brave (and any Chromium browser) that adds a small,
draggable overlay to every page with video: slow down / speed up playback,
and boost audio volume beyond the browser's normal 100% cap. The overlay
follows the page into fullscreen, and playback settings are re-applied
automatically if the site tries to reset them (e.g. after seeking).

## Features

- **Playback speed** — 0.25x to 4x, in 0.1x steps, via the overlay, the
  popup, or keyboard shortcuts.
- **Audio boost** — up to 400% volume using a Web Audio gain node (works
  even where the site's own volume slider caps at 100%), protected by an
  always-on limiter so boosted audio doesn't clip/distort.
- **Smart Volume** — an auto-gain mode (toggle the "AUTO" pill next to
  Volume boost, or the checkbox in the popup) that continuously measures
  the audio it's producing and rides the gain toward a safe target
  loudness: it pushes quiet passages up to as loud as it safely can and
  ducks loud passages back down, all while staying under the limiter's
  clipping threshold. Manual boost is ignored while this is on.
- **Overlay survives fullscreen** — if a site fullscreens a wrapper div
  (most players do: YouTube, Netflix, Twitch, etc.) the overlay renders
  inside it. If a page fullscreens the bare `<video>` tag itself (some
  simple `<video controls>` embeds), Volocity re-targets fullscreen to its
  parent element so the overlay still has somewhere to render.
- **Settings persist per site** and are restored automatically — including
  after the "reset on seek" issue: Volocity listens for `seeked`,
  `ratechange`, `loadedmetadata`, etc. and re-applies your chosen
  speed/boost, plus runs a lightweight watchdog every 700ms while a video is
  playing to catch any player that resets things silently without firing
  those events.
- **Popup** for quick adjustment without opening the overlay, with sliders,
  quick presets, and a per-site reset button.
- **Per-site on/off toggle** (the "ON"/"OFF" pill on the overlay, or the
  checkbox at the top of the popup). When off, Volocity doesn't touch
  `playbackRate` or audio at all - useful on sites like YouTube whose own
  speed controls Volocity's reassert-on-`ratechange` logic would otherwise
  fight with.
- **The overlay only appears once a real `<video>` is found on the page.**
  It's never built on pages with no video (login pages, search results,
  captcha/security-check pages, etc.), so it can't visually collide with
  that page's own UI.
- **The closed-shadow-DOM workaround (`shadow-patch.js`) is scoped to a
  small allowlist of domains** (currently Prime Video), not run on every
  site. It works by forcing `Element.prototype.attachShadow` open so a
  hidden `<video>` becomes reachable - a legitimate DOM-visibility trick,
  but also exactly the kind of prototype tampering bot-detection services
  (Cloudflare, etc.) fingerprint as a bot signal. Running it everywhere
  broke CAPTCHA verification on unrelated sites; keeping it to specific
  domains that actually need it avoids that. If you hit another
  closed-shadow-DOM streaming site, add its pattern to the first
  `content_scripts` entry's `matches` array in `manifest.json`.
- **Keyboard shortcuts** (editable in `brave://extensions/shortcuts`):
  - `Alt+Shift+↑` / `Alt+Shift+↓` — speed up / down
  - `Alt+Shift+→` / `Alt+Shift+←` — boost up / down
  - Show/hide overlay has no default binding (Chrome/Brave caps a manifest
    at 4 pre-assigned shortcuts) — set one yourself at
    `brave://extensions/shortcuts` if you want it.

## Project layout

```
Volocity/
  manifest.json
  icons/                 (16/48/128 px toolbar + store icons)
  src/
    content.js            content script: finds videos, applies rate/boost, renders overlay
    content.css            isolates the overlay host from page styles
    background.js          service worker: relays keyboard shortcuts
    popup.html/.js/.css    toolbar popup UI
```

Settings are stored in `chrome.storage.local`, keyed by hostname, so each
site remembers its own speed/boost/overlay position independently.

## Load it in Brave (unpacked, for your own use)

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `Volocity` folder (the one containing `manifest.json`).
5. Pin it from the puzzle-piece icon in the toolbar if you want quick access
   to the popup.

That's it — no build step, it's plain JS/HTML/CSS. Reload the extension
from `brave://extensions` after any code changes.

## Publishing

Brave uses the **Chrome Web Store** for extension distribution (Brave reads
extensions from the same store; there's no separate Brave store). To
publish there:

1. **Package it.** Zip the contents of the `Volocity` folder (not the
   folder itself — `manifest.json` must be at the zip root):
   ```bash
   cd Volocity
   zip -r ../volocity.zip . -x ".*"
   ```
2. **Create a developer account.** Go to the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   and pay the one-time $5 registration fee if you haven't already.
3. **New item → upload `volocity.zip`.**
4. **Fill in the listing**: description, at least one 1280x800 (or
   640x400) screenshot, category (Productivity or Tools), and a **privacy
   policy URL** — required once you have any permission beyond the bare
   minimum. Volocity only requests `storage`, so you can likely use a
   one-paragraph policy stating you collect no personal data and store
   settings locally only (host it anywhere, e.g. a GitHub Gist).
5. **Submit for review.** Typical review time is a few hours to a few
   days. You'll get an email when it's approved or if changes are
   requested.
6. Once approved, it's installable in Brave directly from the Chrome Web
   Store listing page (Brave supports installing Chrome Web Store
   extensions natively).

If you only want it for yourself, you can skip publishing entirely and
just keep using **Load unpacked** — Brave doesn't require a signed/store
build for local, unpacked extensions.

## Known limitations

- Audio boost requires routing the video through the Web Audio API, which
  Volocity deliberately never attempts on DRM-protected video (checked via
  `video.mediaKeys`), and only ever attempts once the video's `currentTime`
  has actually been observed advancing (encrypted media can't advance until
  its DRM key session is ready, so this avoids ever touching the graph
  mid-negotiation). On any video where the graph still can't be created
  (rare — e.g. strictly cross-origin video without CORS headers), Volocity
  logs a console note and falls back to speed-control-only; it never blocks
  playback on its own.
- **Volocity never calls `addEventListener` on the site's own `<video>`
  element**, for any site. Earlier versions did (to reassert settings on
  `seeked`/`ratechange`/etc.), but testing found that Hotstar's
  Shaka-Player-based UI hangs indefinitely the instant *any* listener is
  registered on its video element — before Volocity changes anything.
  Everything (applying rate/boost, detecting play/pause, detecting errors)
  is now driven by polling from the watchdog tick instead (see `pollVideo`
  in `content.js`), which is also what a working Hotstar-specific
  speed-control tool does for the same reason. This is a strict superset of
  the old event-based approach, not a downgrade — it still re-applies
  settings after a seek/reset, just via polling rather than specific events.
- `DEFAULT_OFF_HOSTS` in `content.js`/`popup.js` exists as an escape hatch
  for any site that turns out to still be incompatible for some other
  reason — currently empty. If you hit a site where Volocity's mere
  presence (not a specific setting) breaks playback, that's the place to
  add it, defaulting that site to off while still letting a user opt back
  in per-visit.
- If a site fullscreens the raw `<video>` element and that element has no
  parent to re-target fullscreen onto (very rare), the overlay is hidden
  for the duration of fullscreen rather than breaking playback.
