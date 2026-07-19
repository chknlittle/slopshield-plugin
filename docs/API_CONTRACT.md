# SlopShield API contract used by the extension

The extension talks directly to [`slopshield-api`](https://github.com/chknlittle/slopshield-api) in two phases.

## 1. Look up visible videos

```http
POST /v1/analyses
Content-Type: application/json

{
  "videos": [
    {
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx",
      "evidence_candidate": true
    }
  ]
}
```

Each response entry is one of:

- `completed`: apply the cached `is_ai` result immediately.
- `queued` or `running`: leave visible and poll later. This may mean the video is waiting for its channel's evidence video.
- `missing` with `needs_transcript: true`: fetch captions in the browser. The API returns this only for the channel's selected evidence video.
- `failed`: leave visible and stop retrying automatically.

If the API has a stored transcript but no score for the active engine version, it queues analysis itself and returns `queued`; the browser does not fetch the transcript again.

## 2. Submit browser-fetched transcripts

For missing videos, Firefox obtains the transcript through the user's YouTube session and submits:

```http
POST /v1/analyses
Content-Type: application/json

{
  "videos": [
    {
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx",
      "evidence_candidate": false,
      "transcript": "[0.00 -> 3.20] Timestamped caption text"
    }
  ]
}
```

The API persists the transcript and returns `queued`. Subsequent polls omit the transcript. `evidence_candidate` is true only when a card is in the viewport; once the API has claimed an evidence video, its transcript submission is accepted regardless of that flag.

A response entry has this shape:

```json
{
  "input_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "video_id": "dQw4w9WgXcQ",
  "channel_id": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "engine_version": "v1",
  "status": "completed",
  "cached": true,
  "needs_transcript": false,
  "is_ai": false,
  "classification_source": "channel",
  "evidence_video_id": "anotherVid1",
  "result": {},
  "error": null
}
```

Only a completed `is_ai: true` entry hides a card. `classification_source` distinguishes a direct `video` result from a `channel`-inherited result. Inferred results always identify the directly analyzed `evidence_video_id`. All failures remain visible.

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
