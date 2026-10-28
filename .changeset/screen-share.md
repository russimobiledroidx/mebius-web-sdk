---
"@mebius-io/web": minor
"@mebius-io/react": minor
---

Screen share. `Mebius.createScreenViewer()` watches a screen session (`watch({ sessionId, token, iceServers? }, video)`, retrying while the device has not started sending) and, in a `control` session, sends mouse, wheel and keyboard as fractions of the picture in per-frame batches, renewing the view token through `enableControl({ refreshToken })`. `Mebius.createScreenShare()` shares the browser's screen as an enrolled device: `enrollIfNeeded(code)`, `start()` from a click, `stop()`, with `viewing` / `ended` / `stopped` events. `BroadcasterOptions.source` publishes an app-supplied `MediaStream` instead of capturing the camera. React: `useScreenViewer()`.
