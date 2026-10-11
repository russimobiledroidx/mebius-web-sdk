---
"@mebius-io/web": minor
---

Quality selection on laddered streams. When a delivery carries `renditions`
(1080p/720p/480p), `player.qualities` lists them, `player.setQuality("auto" | id)`
switches, `player.setMaxQuality(height)` caps `"auto"`, and a new
`quality-changed` event (`{ id, auto }`) reports what is on screen. Deliveries
without `renditions` play exactly as before. The broadcaster now asks the camera
for 1920x1080@30 as an `ideal` constraint; the 2500 kbps default bitrate ceiling
is unchanged (`maxBitrateKbps: 5000` for laddered tenants).
