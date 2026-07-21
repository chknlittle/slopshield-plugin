import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

await import("../src/content-helpers.js");

const { indexAnalysisResults, summarizeVideoStates } = globalThis.__slopShieldHelpers;

test("matches shuffled API results to the correct videos by immutable ID", () => {
  const videos = [
    { videoId: "humanVid01A" },
    { videoId: "aiVideo002B" },
    { videoId: "noCaptions3" },
  ];
  const response = [
    { videoId: "aiVideo002B", status: "completed", isAi: true },
    { videoId: "noCaptions3", status: "failed" },
    { videoId: "humanVid01A", status: "completed", isAi: false },
  ];

  const indexed = indexAnalysisResults(response);

  assert.equal(indexed.get(videos[0].videoId).isAi, false);
  assert.equal(indexed.get(videos[1].videoId).isAi, true);
  assert.equal(indexed.get(videos[2].videoId).status, "failed");
});

test("summarizes the complete feed canary without overstating coverage", () => {
  const stats = summarizeVideoStates({
    videoIds: ["humanVid01A", "aiVideo002B", "noCaptions3", "stillCheck4"],
    classifications: new Map([
      ["humanVid01A", { isAi: false }],
      ["aiVideo002B", { isAi: true }],
    ]),
    failures: new Map([["noCaptions3", "unavailable"]]),
    hiddenVideoIds: ["aiVideo002B"],
  });

  assert.deepEqual(stats, {
    scannedCount: 4,
    checkedCount: 2,
    cleanedCount: 2,
    safeCount: 1,
    aiCount: 1,
    hiddenCount: 1,
    checkingCount: 1,
    unavailableCount: 1,
    failedCount: 0,
  });
});

test("keeps the API video identity in the background response adapter", async () => {
  const source = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  assert.match(source, /videoId:\s*analysis\.video_id/);
});
