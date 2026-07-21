# SlopShield privacy summary

SlopShield reads YouTube video URLs and immutable channel IDs so it can check whether videos have already been classified. When a classification needs evidence, it also reads the video's available captions through the user's active YouTube session.

The extension sends those video URLs, channel IDs, and requested caption text to the SlopShield API solely to classify AI-generated videos and return the filtering result. It does not send the user's YouTube account credentials, cookies, watch history, or the contents of unrelated pages.

SlopShield stores the on/off preference in browser-synced extension storage. Classification results and evidence submitted to the SlopShield API may be cached so future checks do not repeat the same work.
