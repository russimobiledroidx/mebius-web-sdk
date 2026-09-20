---
"@mebius-io/web": minor
"@mebius-io/react": minor
"@mebius-io/react-native": minor
---

Cap what the publish encoder may send.

Nothing bounded a broadcaster's bitrate. `createBroadcaster` took capture
constraints, and those bound the SOURCE — how many pixels arrive per second —
while the encoder still decides how many bits to spend describing them. On a
capable machine with high-motion content it decides near the top of its range.

That is not a device-local decision. Nothing transcodes anywhere in the path, so
every viewer is delivered at exactly the bitrate published here: one host's
encoder is multiplied by the size of the audience, and that is the delivery bill.
A number that looks generous for one host is a bandwidth bill for a thousand
viewers.

`BroadcasterOptions.maxBitrateKbps` sets the ceiling on the video sender's
encoding parameters, which is the only place it is real. It defaults to 3500,
matched to the studio's encoder, so the same broadcast costs the same whichever
path it came from — and every Mebius SDK now carries that same number. A ceiling,
not a target: still scenes still cost less. Pass 0 to lift it.

Applied best effort. A browser that refuses the parameters publishes uncapped
rather than failing to go live: an unbudgeted broadcast beats no broadcast, and
the stats report the truth either way.
