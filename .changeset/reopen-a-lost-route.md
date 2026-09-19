---
"@mebius-io/web": minor
"@mebius-io/react": minor
"@mebius-io/react-native": minor
---

Reopen a delivery route that stops delivering, instead of leaving a frozen frame.

Route selection ran exactly once, at `play()`. Whatever produced the first frame
served the rest of the session, and when it later died — a CDN edge restarting, a
publisher reconnecting, a second of lost network — the element simply held its last
decoded frame. The SDK emitted `buffering` and then nothing at all: no retry, no
failover, no `ended`. The viewer's word for that is a black screen, and the only
cure was reloading the page.

On a 90-minute watch it looked like bad luck. On a channel that runs for a day it is
a certainty, because every one of those causes happens more than once a day.

The player now supervises the route it accepted. A route that reports it ended, or
that stalls for longer than 10 seconds, is treated as lost: the player tears it down
and walks the full candidate list again, because the usual causes take out one route
and not the others. Reopening backs off (1s, 2s, 4s, 8s, 16s) and gives up after five
attempts, at which point `ended` is emitted — bounded on purpose, since every viewer
of one broadcast fails at the same instant and an unbounded retry from a full room is
how a recovery mechanism becomes the outage.

`buffering` is emitted as soon as recovery starts, so a UI shows its spinner rather
than a still picture it has no reason to distrust. `playing` follows when a route is
serving again. An app that already restarts playback on its own keeps working: the
recovery is dropped the moment `stop()` is called, including from inside a backoff.

Refreshed credentials need no special handling here. The client renews the token on
its own schedule whether or not anything is playing, and every transport stamps the
current token when it builds its URL, so a route reopened after a long stall connects
with today's credential.
