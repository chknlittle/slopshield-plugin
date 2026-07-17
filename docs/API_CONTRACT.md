# SlopShield API contract used by the extension

The extension talks directly to [`slopshield-api`](https://github.com/chknlittle/slopshield-api).

## Submit and read analyses

```http
POST /v1/analyses
Content-Type: application/json

{
  "urls": [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  ]
}
```

The response preserves input order:

```json
{
  "engine_version": "v1",
  "summary": {
    "total": 1,
    "valid": 1,
    "invalid": 0,
    "queued": 0,
    "running": 0,
    "completed": 1,
    "failed": 0
  },
  "analyses": [
    {
      "input_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "video_id": "dQw4w9WgXcQ",
      "engine_version": "v1",
      "status": "completed",
      "cached": true,
      "is_ai": false,
      "result": {},
      "error": null
    }
  ]
}
```

Missing analyses return immediately as `queued`. The extension submits queued or running videos again later to read their current state.

Only `status` and `is_ai` control filtering:

- Completed and `is_ai: true` means hide.
- Completed and `is_ai: false` means show.
- Every other state means show.

## Health

```http
GET /health
```

The extension reads:

```json
{
  "ok": true,
  "engine": {
    "version": "v1",
    "reachable": true
  }
}
```
