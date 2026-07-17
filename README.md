# SlopShield Chrome extension

SlopShield hides videos that the SlopShield API has classified as AI-generated. It scans the normal YouTube cards already visible in the browser; transcript retrieval and model inference stay in the backend.

This fork uses the real [`slopshield-api`](https://github.com/chknlittle/slopshield-api). The old mock scores, strictness slider, and preview mode have been removed. Filtering is simply on or off.

## Run locally

1. Start `slopshield-api` on tabitha. Its persistent Cloudflare Tunnel is available at `https://slopshield-api.chkn.computer`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository.
5. Refresh any YouTube tabs that were already open.

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
manifest.json       Chrome Manifest V3 configuration
src/background.js   SlopShield API requests and health checks
src/content.js      YouTube card discovery, queueing, and filtering
src/content.css     Hidden-card and API-offline styles
popup/              On/off switch, health, and hidden count
```

## API configuration

The API URL is `https://slopshield-api.chkn.computer`, defined in `src/background.js`. The origin must also appear in `manifest.json` under `host_permissions`.

See [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the API fields used by the extension.
