# SlopShield browser extension

SlopShield hides videos that the SlopShield API has classified as AI-generated. It scans the normal YouTube cards already visible in the browser; transcript retrieval and model inference stay in the backend.

This fork uses the real [`slopshield-api`](https://github.com/chknlittle/slopshield-api). The old mock scores, strictness slider, and preview mode have been removed. Filtering is simply on or off.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository.
4. Refresh any YouTube tabs that were already open.

## Install temporarily in Firefox

Firefox uses a background script rather than Chrome's Manifest V3 service worker, so it needs its own manifest. Build the Firefox directory with Node.js 18 or newer:

```bash
node scripts/build-firefox.mjs
```

Then:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `dist/firefox/manifest.json`.
4. Refresh any YouTube tabs that were already open.

Firefox removes temporary add-ons when the browser closes. Everyday installation will require a Mozilla-signed XPI.

The popup reports API/engine health and the number of AI videos hidden on the current page.

## Behavior

The extension sends visible video URLs to `POST /v1/analyses` in batches of up to 50.

- `completed` with `is_ai: true`: hide the video card.
- `completed` with `is_ai: false`: leave it visible.
- `queued` or `running`: leave it visible and check again later.
- `failed` or invalid: leave it visible.

Results are cached by the backend. The extension never hides a video because of an engine, transcript, or network failure.

YouTube Shorts and Shorts shelves are intentionally ignored.

## Source layout

```text
manifest.json            Chrome Manifest V3 configuration
manifest.firefox.json    Firefox Manifest V3 configuration
scripts/build-firefox.mjs  Creates the loadable Firefox directory
src/background.js        SlopShield API requests and health checks
src/content.js           YouTube card discovery, queueing, and filtering
src/content.css          Hidden-card and API-offline styles
popup/                   On/off switch, health, and hidden count
```

## API configuration

The API URL is `https://slopshield-api.chkn.computer`, defined in `src/background.js`. The origin must also appear under `host_permissions` in both browser manifests.

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the API fields used by the extension.
