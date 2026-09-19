---
"@mebius-io/web": minor
"@mebius-io/react": minor
"@mebius-io/react-native": minor
---

Tell the player, honestly, which renditions a stream actually has.

A player UI inherited from an HLS ladder has a quality menu, and until now the SDK
said nothing about renditions at all — so the only choices were to show a menu that
changes nothing or to delete the feature on a hunch. Mebius transcodes no ladder: a
live stream has exactly one rendition.

`player.qualities` is that answer as data. It is `[]` today for every stream, which
means "there is nothing to choose" and is the cue to hide the menu. `setQuality(id)`
takes `"auto"` (the default) or an id from that list, and rejects anything else
instead of silently doing nothing — playback is untouched by the rejection.
`qualities-changed` fires once per accepted delivery route, because the list is a
property of the route, not of the player.

Nothing changes for a caller that does not touch these two members.

Two fixes found while reviewing the above, both on paths that already existed:

A listener that throws no longer takes the session with it. Events are emitted on
the SDK's own hot paths, and an exception escaping one unwound into route
acceptance — tearing down a stream that had already delivered its first frame and
reporting it as a connection failure. Each listener is now isolated and a throw is
logged, so one bad subscriber cannot starve the others either.

A refreshed token that is not newer than the one it replaces is now treated as a
failed mint rather than as the end of the session: retried under backoff while the
current credential is still valid, and reported as `TOKEN_EXPIRED` only once it
genuinely is not. A backend briefly serving a cached credential used to end
playback a full minute before the token it held actually expired — worse than not
refreshing at all.
