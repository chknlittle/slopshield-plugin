const DEFAULT_SEED = "slopshield-demo-v1";

export function classifyVideos(videos, options = {}) {
  const threshold = clamp(Number(options.threshold ?? 0.7), 0, 1);
  const seed = String(options.seed || DEFAULT_SEED);

  return videos.map((video) => {
    const videoId = String(video.videoId || "");
    const slopScore = scoreFromKey(`${seed}:${videoId}`);
    const isSlop = slopScore >= threshold;

    return {
      videoId,
      slopScore,
      isSlop,
      verdict: isSlop ? "block" : "allow",
      source: "mock",
      signals: {
        textAiScore: null,
        syntheticVoiceScore: null,
      },
    };
  });
}

export function scoreFromKey(key) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return Number(((hash >>> 0) / 0xffffffff).toFixed(4));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

