# SlopShield plugin TODO

## I can do now

- [x] Test a fresh unpacked installation in Chrome and document any missing step.
- [x] Test normal videos on YouTube Home, Search, Subscriptions, channel pages, and the Watch-page sidebar.
- [x] Test infinite scrolling and navigation between pages without a full reload.
- [x] Confirm Shorts shelves and `/shorts/` pages are never filtered.
- [x] Test the switch, preview mode, and strictness at 0%, 50%, and 100%.
- [x] Stop the mock server and confirm YouTube remains usable and shows a clear offline status.
- [x] Restart the server and confirm classification recovers without reinstalling the extension.
- [x] Test two YouTube tabs at the same time and check for duplicate or inconsistent results.
- [x] Add proper extension icons for the toolbar and `chrome://extensions`.
- [x] Run `npm test` and perform one final fresh-profile demo before submission.

### Acceptance-test notes — 2026-07-14

Passing checks:

- Home: 23 visible normal-video cards received preview results.
- Search: 20 visible normal-video results received preview results.
- Subscriptions: preview results continued across the loaded feed.
- Channel video grid: 30 visible video links received preview results.
- Watch page: related-video thumbnails received a mixture of `FLAG` and `ALLOW` badges after adding support for YouTube's current lockup component.
- Infinite scroll kept labels on newly visible cards; SPA navigation to Subscriptions reclassified the destination feed.
- Shorts page received zero labels. A Shorts shelf also stayed untouched while neighboring normal results were classified.
- Strictness behaved correctly: 0% produced only `ALLOW`, 100% only `FLAG`, and 50% produced a mixed feed.
- Preview off hid the flagged portion; the main switch restored every card.
- With the server stopped, 25 normal search results remained visible and the page showed the exact offline warning. After restart, the warning cleared and classifications returned without reinstalling.
- Two tabs produced the same first five results for the same videos: `72 FLAG`, `94 FLAG`, `55 FLAG`, `5 ALLOW`, `9 ALLOW`.
- Popup counts are tab-local: the Watch page reported 13 flagged videos while a Search tab reported 10.
- A persistent popup changed to `offline` within five seconds of stopping the server and recovered to `Mock engine online` within five seconds of restart, without reopening it.
- Fresh-profile demo: created the `SlopShield Test` Chrome profile, loaded the repository unpacked, verified version 0.3.0 and the toolbar/extensions-page icon, classified a signed-out YouTube Search page, and saw `04` flagged videos plus online health in the popup.
- `npm test` passed all 3 tests; all extension JavaScript files passed syntax checks.

Resolved during the acceptance pass:

1. Added Watch-page support for YouTube's current `yt-lockup-view-model` component.
2. Replaced the shared stored count with an active-tab content-script query.
3. Added periodic popup health and page-stat refreshes.
4. Added 16, 32, 48, and 128 px extension icons.
5. Completed the fresh-profile install and demo on version 0.3.0.

## Open questions to send to the API/engine teammates

These are coordination questions, not incomplete plugin checks:

- Confirm the final request and response format in [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).
- Provide the deployed HTTPS API URL and expected batch-size limit.
- Confirm whether results are immediate or require a `pending` response plus polling.
- Agree that `slopScore` is always a number from 0 to 1 and define what it represents.
- Define responses for missing transcripts, private/deleted videos, timeouts, and engine errors.
- Confirm who caches results by `videoId` and for how long.
- Confirm authentication and rate limiting; no secret API key may be shipped inside the extension.
- Provide several known allow/block video IDs for end-to-end integration testing.

## Plugin definition of done

- [x] Major normal-video YouTube surfaces work and Shorts remain untouched.
- [x] API failures never break or empty the YouTube feed.
- [x] The real API can replace the mock with only endpoint/permission configuration changes, provided it implements the documented contract.
- [x] Preview, filtering, strictness, and restoration through the main switch work reliably.
- [x] A repeatable 30–60 second demo works from a fresh Chrome installation.
