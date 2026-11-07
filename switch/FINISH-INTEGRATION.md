# Browser Finish integration: not implemented

The browser Finish action does **not** currently dispatch a package to Switch. The optional bridge remains a manual adapter for an existing proposed revision. Do not present its unit tests as proof of browser-to-Switch delivery.

## Evidence from the existing paths

- `public/review-mode.js` builds the real transcript and collage in the Finish handler after pending feedback saves and recording completion. The collage is a browser Blob/data URL displayed locally, copied or downloaded. There is no durable server collage URL.
- `public/review-package.js` generates collage pixels and transcripts, but does not persist the collage to the backend.
- The hosted recording upload route in `vercel-backend/handler.js` accepts WebM; the documented private storage bucket restricts MIME type to WebM. Reusing it for a PNG would violate the existing storage contract.
- Finish uses a UUID review-session identifier on annotations. Hosted revision IDs are separate 32-character hexadecimal IDs. A finished package needs an explicit persisted association with a later revision; they must not be silently conflated.
- The existing `switch-handoff` routes enforce owner authorization, but accept text rather than a durable finished-package envelope. The optional `switch/bridge.js` requires an existing proposed revision before its first post.

## Required connection, in implementation order

1. Persist the actual finished package, including transcript, a bounded PNG collage, and the saved room-scoped recording reference. Provide an authenticated collage read path and explicit size/retention rules. Do not publish a Blob URL, data URI or pretend a room page is a collage link.
2. Add an unchecked per-review sharing choice, shown only when the server reports the feature configured and the viewer is an owner. Server authorization and explicit request consent remain authoritative; a browser flag or a stored Switch secret is insufficient.
3. After successful Finish persistence, reserve a durable idempotent dispatch entry scoped to its Review Room and finished-review ID. Bind the server-selected Switch destination and configured coding-agent name; do not accept arbitrary destinations from guests or browser payloads.
4. Consume that entry using the documented Switch client already in `switch/bridge.js`. Post the real sanitized transcript, authenticated collage link and replay URL; retain the returned thread root and address the configured coding agent in that thread. Initial package posting must not require a proposal.
5. Associate an owner-created revision with that same finished package/thread. Continue using the existing revision worker, canonical proposal hash and owner-authenticated approval API. Until that association and proposal exist, approval stays disabled. Never infer approval from an agent's message or regenerate approved bytes.
6. Test the actual Finish handler through package persistence and mocked Switch dispatch. Cover disabled configuration, unchecked consent, guest/server rejection, missing/failed replay upload, collage failure, duplicate Finish, dispatch outage and retry without duplicate external messages. Preserve Finish's normal local result on Switch failure.

No route, schema migration, UI opt-in, dispatch consumer or browser Finish integration test was added in this follow-up. No live message or runtime demonstration occurred. These are remaining implementation requirements, not claims about existing behavior or upstream API contracts.
