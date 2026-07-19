# SlopShield browser extension

SlopShield hides videos that the SlopShield API has classified as AI-generated. It scans normal YouTube cards, reuses cached scores immediately, and fetches missing transcripts through the user's active YouTube browser session. Model inference stays in the backend.

This fork uses the real [`slopshield-api`](https://github.com/chknlittle/slopshield-api). The old mock scores and strictness slider have been removed. Filtering is simply on or off; switching it off reveals already-classified AI cards with provenance badges.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository.
4. Refresh any YouTube tabs that were already open.

## Install temporarily in Firefox

Firefox uses a background script rather than Chrome's Manifest V3 service worker, so it needs its own manifest. Install build dependencies and build the Firefox directory with Node.js 18 or newer:

```bash
npm install
npm run build:firefox
```

Then:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `dist/firefox/manifest.json`.
4. Refresh any YouTube tabs that were already open.

Firefox removes temporary add-ons when the browser closes. Everyday installation will require a Mozilla-signed XPI.

The popup reports API/engine health and the number of AI videos hidden on the current page.

## Behavior

The extension extracts each video's immutable `UC…` channel ID from YouTube renderer data (with no handle/name fallback), then sends discovered videos to `POST /v1/analyses` in batches of up to 50. Cached video or channel classifications are applied immediately. For a new channel, the API selects one evidence video; its transcript is fetched only after its card enters the viewport. Other videos from that channel wait and inherit the evidence verdict without fetching transcripts.

- `completed` with `is_ai: true`: hide the video card.
- `completed` with `is_ai: false`: leave it visible.
- `queued` or `running`: leave it visible and check again later.
- `missing` with `needs_transcript: true`: fetch captions in Firefox and submit them.
- `failed` or invalid: leave it visible.

For missing videos that enter the viewport, the page bridge runs YouTube's BotGuard challenge once, reuses its WebPO minter, mints a content-bound token per video, and fetches timestamped captions through the user's IP/session. Transcript jobs run one at a time with at least 1 second between starts. Transient YouTube/network failures trigger a shared exponential cooldown (30 seconds up to 5 minutes) so one rate limit cannot cause a retry storm. No hidden tabs or video navigation are used.

Results are cached by the backend. Thumbnail badges show `Checking…` while a result is pending, `✓ Verified` for a directly analyzed non-AI video, and `✓ Channel verified` for a non-AI verdict inherited from the channel's evidence video. AI-classified cards are hidden while filtering is enabled. Turning filtering off reveals direct AI results as `AI detected` and inherited results as `AI channel`, making the disabled state useful as a preview. Failures remain visible with a `Check failed` badge. Videos without an immutable channel ID or usable transcript remain visible with an `Unavailable` badge.

YouTube Shorts and Shorts shelves are intentionally ignored.

## Source layout

```text
manifest.json            Chrome Manifest V3 configuration
manifest.firefox.json    Firefox Manifest V3 configuration
scripts/build-firefox.mjs  Creates the loadable Firefox directory
src/background.js        SlopShield API requests and health checks
src/content.js           Card discovery, two-phase queueing, and filtering
src/webpo-page-entry.js   Browser transcript/WebPO source
src/webpo-page.js         Generated page-context browser bundle
src/content.css          Hidden-card and API-offline styles
popup/                   On/off switch, health, and hidden count
```

## API configuration

The API URL is `https://slopshield-api.chkn.computer`, defined in `src/background.js`. The origin must also appear under `host_permissions` in both browser manifests.

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the API fields used by the extension.
