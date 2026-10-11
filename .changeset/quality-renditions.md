---
"@mebius-io/web": minor
---

Quality selection on laddered streams. When a delivery carries `renditions`
(1080p/720p/480p), `player.qualities` lists them, `player.setQuality("auto" | id)`
switches, `player.setMaxQuality(height)` caps `"auto"`,
`player.setAllowedQualities(ids | null)` restricts the ladder a viewer may get,
and a new `quality-changed` event (`{ id, auto }`) reports what is on screen. A
pick overrides the cap, a picked rendition the stream lacks falls back to auto,
and all of it survives a route reopen. Deliveries
without `renditions` play exactly as before. A broadcaster created with
`maxBitrateKbps` above the 2500 default (e.g. `5000` for laddered tenants) also
asks the camera for 1920x1080@30 as an `ideal` constraint; without it capture is
unchanged.
