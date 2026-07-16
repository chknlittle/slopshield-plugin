import assert from "node:assert/strict";
import test from "node:test";
import { classifyVideos, scoreFromKey } from "../mock-server/classifier.js";

test("mock scores are deterministic for a video", () => {
  assert.equal(scoreFromKey("seed:abc123"), scoreFromKey("seed:abc123"));
});

test("mock classifier preserves video IDs and applies the threshold", () => {
  const videos = [{ videoId: "abc123" }, { videoId: "xyz789" }];
  const results = classifyVideos(videos, { seed: "test", threshold: 0.5 });

  assert.deepEqual(results.map((result) => result.videoId), ["abc123", "xyz789"]);
  for (const result of results) {
    assert.equal(result.isSlop, result.slopScore >= 0.5);
    assert.equal(result.verdict, result.isSlop ? "block" : "allow");
  }
});

test("strictness endpoints can allow none or block all", () => {
  const videos = [{ videoId: "one" }, { videoId: "two" }];

  assert.ok(classifyVideos(videos, { threshold: 1 }).every((result) => !result.isSlop));
  assert.ok(classifyVideos(videos, { threshold: 0 }).every((result) => result.isSlop));
});

