# Room server

Run `npm start` for a loopback-only local server on `127.0.0.1:3000`. Set `PORT`, `HOST`, or `REVIEW_ROOM_DATA_DIR` to change the listener or storage path. Run `npm test` for the server checks.

## Access modes

Local mode has no authentication and refuses non-loopback binds. In secure mode set `REVIEW_OWNER_PASSWORD` to a secret of at least 32 characters and `REVIEW_PUBLIC_ORIGIN` to the exact HTTPS origin without a trailing slash. `NODE_ENV=production` requires both values. Secure mode rejects mutating requests whose `Origin` differs from the configured origin. The server itself speaks HTTP. Put it behind a trusted HTTPS proxy and prevent direct public access to its HTTP port.

Secure mode offers an owner password session through `POST /api/owner/session`. The owner can list and create rooms, create and revoke invitations, delete recordings, and send Switch handoffs. `GET /api/auth/status` reports whether secure mode is enabled and whether the request has an owner session. `POST /api/owner/logout` ends that owner session.

`POST /api/rooms/:id/invitations` creates a random invitation that expires after seven days. The URL puts its secret in a fragment. `POST /api/rooms/:id/join` exchanges the token for a room-scoped cookie. Only token hashes are stored on the server. Multiple unexpired invitations can coexist, up to 100 per room. `DELETE /api/rooms/:id/invitations` revokes invitations and guest sessions, sends an `access-revoked` control event, and closes the event streams. The browser closes peer connections on revocation or event-stream failure.

Owner and guest sessions are held in memory. A server restart invalidates them; guests need an unexpired invitation again. Invitations are transferable and do not verify a client's identity. Recordings, room data, signaling, and ICE configuration require an owner or a guest session for that room. The unscoped legacy recording URL is disabled in secure mode.

## Events and storage

`GET /api/rooms/:id` returns room details and persisted events. `GET /api/rooms/:id/events` streams new events. Pass the last persisted event ID as `?cursor=<id>` to replay subsequent events before live events. `Last-Event-ID` takes precedence on reconnect. An unknown cursor returns HTTP 409. Pass `?cursor=0` to replay a room from the start.

Notes, note status changes, drawings, and recordings are persisted. Presence and signaling events are transient. Their SSE frames do not advance the persisted cursor. The event endpoint validates the supported event shapes, restricts note status updates to notes in the room, and rejects client-submitted `switch_reply` events. An uploaded recording event must reference a recording in the same room.

Secure mode limits persisted room data to 4 MiB per room and 64 MiB across rooms, with at most 20,000 persisted events per room. Uploads are limited to 100 MiB each and saved recording files to 256 MiB across the server. The owner can delete a recorded file with `DELETE /recordings/:roomId/:recordingId`. The server records a deletion event so clients remove its replay. For orphan uploads, use the separate [maintenance tool](../tools/STORAGE-MAINTENANCE.md). Its deletion mode requires the operator to stop all app instances first.

## ICE configuration

The authenticated `GET /api/rooms/:id/ice-config` supplies WebRTC ICE servers. The default is Google's public STUN server. `ICE_SERVERS_JSON` accepts a JSON array of ICE server objects. Secure mode rejects static TURN entries in that array.

For coturn REST authentication set `TURN_URLS_JSON` to a JSON array of TURN URLs and `TURN_SHARED_SECRET` to a private secret of at least 32 UTF-8 bytes. Optionally set `TURN_CREDENTIAL_TTL_SECONDS` from 300 to 86400. The default is 3600 seconds.

For Cloudflare Realtime TURN set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` as private server secrets. Optionally set `CLOUDFLARE_TURN_TTL_SECONDS` from 300 to 86400. The default is 3600 seconds. Configure only one TURN provider. The Cloudflare provider makes a server-side request to obtain credentials and fails closed when it cannot validate the response. Clients receive short-lived credentials and refresh them before expiry. The app does not provision either relay, and a real relay has not been verified.

## Optional Switch handoff

`POST /api/rooms/:id/switch-handoff` accepts `{ "content": "..." }` and sends it as the configured Switch agent. In secure mode the request requires an owner session. Configure `SWITCH_AGENT_BASE_URL`, `SWITCH_AGENT_ID`, `SWITCH_AGENT_API_KEY`, and `SWITCH_ROOM_ID`. The base URL must use HTTPS or local HTTP on `localhost`, `127.0.0.1`, or `::1`. The Switch room ID is the destination, not the Review Room ID. The agent must already be registered and authorized for that room.

The server does not register agents or establish a general Switch connection. Provision and authorize the target agent separately. The legacy callback is an optional demo integration and is not a general production Switch runtime. See the [revision worker](../switch-host/README.md) for the separate hosted revision workflow.
