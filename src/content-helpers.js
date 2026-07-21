(function exposeSlopShieldHelpers(root) {
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  function indexAnalysisResults(results) {
    const indexed = new Map();
    for (const result of Array.isArray(results) ? results : []) {
      if (VIDEO_ID.test(result?.videoId ?? "")) indexed.set(result.videoId, result);
    }
    return indexed;
  }

  function summarizeVideoStates({ videoIds, classifications, failures, hiddenVideoIds }) {
    const uniqueVideoIds = new Set(videoIds);
    let checkedCount = 0;
    let safeCount = 0;
    let aiCount = 0;
    let unavailableCount = 0;
    let failedCount = 0;

    for (const videoId of uniqueVideoIds) {
      const classification = classifications.get(videoId);
      if (classification) {
        checkedCount += 1;
        if (classification.isAi) aiCount += 1;
        else safeCount += 1;
        continue;
      }

      const failure = failures.get(videoId);
      if (failure === "unavailable") unavailableCount += 1;
      else if (failure === "check-failed") failedCount += 1;
    }

    return {
      scannedCount: uniqueVideoIds.size,
      checkedCount,
      cleanedCount: checkedCount,
      safeCount,
      aiCount,
      hiddenCount: new Set(hiddenVideoIds).size,
      checkingCount: Math.max(
        0,
        uniqueVideoIds.size - checkedCount - unavailableCount - failedCount,
      ),
      unavailableCount,
      failedCount,
    };
  }

  root.__slopShieldHelpers = Object.freeze({ indexAnalysisResults, summarizeVideoStates });
})(globalThis);
