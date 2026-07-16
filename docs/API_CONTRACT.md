# SlopShield classification contract

The extension has one dependency on the backend: `POST /v1/classify`. The mock server implements this contract now; the real API should keep it when the engine is connected.

## Request

```json
{
  "client": { "name": "slopshield-extension", "version": "0.3.0" },
  "strictness": 30,
  "threshold": 0.7,
  "videos": [
    {
      "videoId": "dQw4w9WgXcQ",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "title": "Example title",
      "channel": "Example channel"
    }
  ]
}
```

`strictness` is the user-facing 0–100 value. `threshold` is derived as `1 - strictness / 100`, so higher strictness blocks more videos.

## Response

```json
{
  "requestId": "04f65fe0-d1f5-4b1c-9810-cb441fe4f349",
  "mode": "mock",
  "results": [
    {
      "videoId": "dQw4w9WgXcQ",
      "slopScore": 0.86,
      "isSlop": true,
      "verdict": "block",
      "source": "mock",
      "signals": {
        "textAiScore": null,
        "syntheticVoiceScore": null
      }
    }
  ]
}
```

The real engine may populate the signal fields, but the extension only relies on `videoId` and `slopScore`. This lets the user change strictness locally without rerunning inference.

## Health check

`GET /health` returns:

```json
{ "status": "ok", "mode": "mock", "version": "0.3.0" }
```
