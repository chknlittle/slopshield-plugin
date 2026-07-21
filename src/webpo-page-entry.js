import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import { buildURL, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { executeInterpreter } from "./execute-interpreter.js";

const REQUEST_TYPE = "SLOPSHIELD_TRANSCRIPT_REQUEST";
const RESPONSE_TYPE = "SLOPSHIELD_TRANSCRIPT_RESPONSE";
const CHANNELS_UPDATED_TYPE = "SLOPSHIELD_CHANNELS_UPDATED";
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const CARD_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "yt-lockup-view-model",
].join(",");
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

if (!globalThis.__slopShieldTranscriptBridge) {
  globalThis.__slopShieldTranscriptBridge = true;
  let minterPromise = null;
  let minterExpiresAt = 0;
  let channelScanTimer = null;

  startChannelAnnotations();
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== REQUEST_TYPE) return;

    const { requestId, videoId } = event.data;
    if (typeof requestId !== "string" || !VIDEO_ID.test(videoId)) return;

    void fetchTranscript(videoId)
      .then((result) => {
        window.postMessage({ type: RESPONSE_TYPE, requestId, ok: true, ...result }, "*");
      })
      .catch((error) => {
        window.postMessage({
          type: RESPONSE_TYPE,
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: isRetryableError(error),
        }, "*");
      });
  });

  function startChannelAnnotations() {
    const start = () => {
      new MutationObserver(scheduleChannelScan)
        .observe(document.documentElement, { childList: true, subtree: true });
      scheduleChannelScan();
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  function scheduleChannelScan() {
    if (channelScanTimer !== null) return;
    channelScanTimer = window.setTimeout(() => {
      channelScanTimer = null;
      annotateChannelIds();
    }, 100);
  }

  function annotateChannelIds() {
    let changed = false;
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const videoId = videoIdFromCard(card);
      if (!videoId) continue;
      const annotationMatches = card.dataset.slopshieldChannelVideoId === videoId;
      if (
        annotationMatches && (
          CHANNEL_ID.test(card.dataset.slopshieldChannelId ?? "") ||
          card.dataset.slopshieldChannelUnavailable === "true"
        )
      ) continue;
      delete card.dataset.slopshieldChannelId;
      delete card.dataset.slopshieldChannelUnavailable;
      delete card.dataset.slopshieldChannelVideoId;

      const resolution = card.closest("ytd-watch-next-secondary-results-renderer, #secondary")
        ? resolveWatchRecommendation(card, videoId)
        : { channelId: findChannelIdInRenderer(card), resolved: false };
      if (resolution.channelId) {
        card.dataset.slopshieldChannelId = resolution.channelId;
        card.dataset.slopshieldChannelVideoId = videoId;
        changed = true;
      } else if (resolution.resolved) {
        card.dataset.slopshieldChannelUnavailable = "true";
        card.dataset.slopshieldChannelVideoId = videoId;
        changed = true;
      }
    }
    if (changed) window.postMessage({ type: CHANNELS_UPDATED_TYPE }, "*");
  }

  function resolveWatchRecommendation(card, videoId) {
    const root = card.closest("ytd-item-section-renderer")?.data;
    if (!root) return { channelId: null, resolved: false };

    const channelIds = new Set();
    const seen = new WeakSet();
    const stack = [root];
    let inspected = 0;
    let foundVideoNode = false;
    while (stack.length && inspected < 250_000) {
      const value = stack.pop();
      inspected += 1;
      if (value === null || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);

      const nodeVideoId = typeof value.videoId === "string"
        ? value.videoId
        : typeof value.contentId === "string" && VIDEO_ID.test(value.contentId)
          ? value.contentId
          : null;
      if (nodeVideoId === videoId) {
        foundVideoNode = true;
        for (const channelId of channelIdsInValue(value, 12)) channelIds.add(channelId);
      }

      let children;
      try {
        children = Object.values(value);
      } catch {
        continue;
      }
      for (const child of children) {
        if (child && typeof child === "object") stack.push(child);
      }
    }

    return {
      channelId: channelIds.size === 1 ? channelIds.values().next().value : null,
      resolved: foundVideoNode,
    };
  }

  function videoIdFromCard(card) {
    const anchor = card.querySelector('a[href^="/watch?v="], a[href*="youtube.com/watch?v="]');
    if (!anchor) return null;
    try {
      return new URL(anchor.href, location.origin).searchParams.get("v");
    } catch {
      return null;
    }
  }

  function channelIdsInValue(root, maxDepth) {
    const found = new Set();
    const seen = new WeakSet();
    const stack = [{ value: root, depth: 0 }];
    let inspected = 0;
    while (stack.length && inspected < 30_000) {
      const { value, depth } = stack.pop();
      inspected += 1;
      if (typeof value === "string") {
        if (CHANNEL_ID.test(value)) found.add(value);
        continue;
      }
      if (value === null || typeof value !== "object" || depth >= maxDepth || seen.has(value)) continue;
      seen.add(value);
      let children;
      try {
        children = Object.values(value);
      } catch {
        continue;
      }
      for (const child of children) stack.push({ value: child, depth: depth + 1 });
    }
    return found;
  }

  function findChannelIdInRenderer(card) {
    const seen = new WeakSet();
    const stack = [card.data];
    let inspected = 0;
    while (stack.length && inspected < 20_000) {
      const value = stack.pop();
      inspected += 1;
      if (typeof value === "string") {
        if (CHANNEL_ID.test(value)) return value;
        continue;
      }
      if (value === null || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      let children;
      try {
        children = Object.values(value);
      } catch {
        continue;
      }
      for (const child of children) stack.push(child);
    }
    return null;
  }

  async function fetchTranscript(videoId) {
    const watchResponse = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: "include",
      headers: { accept: "text/html" },
    });
    if (!watchResponse.ok) throw new Error(`YouTube watch page returned HTTP ${watchResponse.status}`);

    const html = await watchResponse.text();
    const player = extractAssignedJson(html, "ytInitialPlayerResponse");
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) {
      throw new Error(player?.playabilityStatus?.reason || "No transcript is available for this video");
    }

    const track =
      tracks.find((item) => item.languageCode === "en" && item.kind !== "asr") ??
      tracks.find((item) => item.languageCode?.startsWith("en")) ??
      tracks[0];

    const minter = await getMinter();
    const poToken = await minter.mintAsWebsafeString(videoId);
    const captionUrl = buildCaptionUrl(track.baseUrl, poToken);
    const captionResponse = await fetch(captionUrl, { credentials: "include" });
    const captionText = await captionResponse.text();
    if (!captionResponse.ok || !captionText) {
      throw new Error(`YouTube transcript returned HTTP ${captionResponse.status} with ${captionText.length} bytes`);
    }

    const transcript = transcriptFromJson3(JSON.parse(captionText));
    if (!transcript) throw new Error("YouTube transcript contained no caption segments");

    return { transcript };
  }

  function getMinter() {
    if (minterPromise !== null && minterExpiresAt > 0 && Date.now() >= minterExpiresAt) {
      minterPromise = null;
    }
    if (minterPromise === null) {
      minterPromise = createMinter().catch((error) => {
        minterPromise = null;
        minterExpiresAt = 0;
        throw error;
      });
    }
    return minterPromise;
  }

  async function createMinter() {
    const challenge = await getChallenge({ fetchFunction: fetch, requestKey: REQUEST_KEY });
    const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreter) throw new Error("YouTube BotGuard interpreter is unavailable");

    const trustedInterpreter = globalThis.trustedTypes
      ? getTrustedTypesPolicy().createScript(interpreter)
      : interpreter;
    executeInterpreter(document, trustedInterpreter);

    const botGuard = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: globalThis,
    });
    const webPoSignalOutput = [];
    const botguardResponse = await botGuard.snapshot({ webPoSignalOutput });
    const integrityResponse = await fetch(buildURL("GenerateIT", false), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    if (!integrityResponse.ok) {
      throw new Error(`YouTube BotGuard integrity request returned HTTP ${integrityResponse.status}`);
    }

    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
      await integrityResponse.json();
    const minter = await WebPoMinter.create(
      { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
      webPoSignalOutput,
    );
    const usableSeconds = Math.max(30, estimatedTtlSecs - mintRefreshThreshold);
    minterExpiresAt = Date.now() + usableSeconds * 1_000;
    return minter;
  }

  function getTrustedTypesPolicy() {
    if (!globalThis.__slopShieldTrustedTypesPolicy) {
      globalThis.__slopShieldTrustedTypesPolicy = globalThis.trustedTypes.createPolicy(
        "slopshield-botguard",
        { createScript: (source) => source },
      );
    }
    return globalThis.__slopShieldTrustedTypesPolicy;
  }
}

function isRetryableError(error) {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(message.match(/HTTP (\d{3})/)?.[1]);
  return status === 408 || status === 429 || status >= 500;
}

function buildCaptionUrl(baseUrl, poToken) {
  const url = new URL(baseUrl);
  const params = {
    potc: "1",
    pot: poToken,
    fmt: "json3",
    xorb: "2",
    xobt: "3",
    xovt: "3",
    cbrand: "apple",
    cbr: "Firefox",
    cbrver: navigator.userAgent.match(/Firefox\/([\d.]+)/)?.[1] ?? "unknown",
    c: "WEB",
    cver: globalThis.ytcfg?.get("INNERTUBE_CLIENT_VERSION") ?? "",
    cplayer: "UNIPLAYER",
    cos: "Macintosh",
    cosver: "10.15",
    cplatform: "DESKTOP",
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function transcriptFromJson3(captions) {
  return (captions.events ?? [])
    .filter((event) => event.segs?.length)
    .map((event) => {
      const start = Number(event.tStartMs ?? 0) / 1000;
      const end = start + Number(event.dDurationMs ?? 0) / 1000;
      const text = event.segs
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      return text ? `[${start.toFixed(2)} -> ${end.toFixed(2)}] ${text}` : null;
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssignedJson(html, variableName) {
  const markers = [
    `var ${variableName} = `,
    `${variableName} = `,
    `"${variableName}":`,
  ];

  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) continue;
    const start = html.indexOf("{", markerIndex + marker.length);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const character = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        return JSON.parse(html.slice(start, index + 1));
      }
    }
  }
  throw new Error(`Could not find ${variableName}`);
}
