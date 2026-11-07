# Review Room

Review Room helps freelancers and small studios collaborate with clients and coding agents in one shared review room: discuss a website, annotate it, save feedback and replay the context behind a requested change.

Hosted private beta: https://review-room-mu.vercel.app. Access requires owner sign-in or an invitation; this is not an unrestricted public demo.

## From feedback to an approved preview

1. The owner creates a room and invites the client with an expiring bearer link.
2. The client and studio share a screen, add annotations and leave feedback. Browser permissions control microphone, screen capture and available audio.
3. Saved replays and timestamped markers help recover the context. Review packages combine markers and available frames; speech recognition can be inaccurate and needs review.
4. For the hosted revision workflow, the owner selects a recording clip and supplies its self-contained HTML source. A separately configured Switch-connected worker uses Whisper and a coding agent to prepare changed HTML and an exact source diff.
5. An authorized human owner reviews the transcript, frames and exact diff, then approves the immutable proposal hash. Guests can contribute feedback and inspect proposals, but cannot request or approve revisions. The worker cannot grant approval.
6. The worker materializes the approved bytes without another model call. A private, hash-verified preview and source download become available to authorized room participants. This does not deploy changes to the original website.

## Local setup

Install Node.js 24, then run:

```sh
npm ci
npm start
```

Open http://localhost:3000. Local mode binds to loopback and has no authentication; use it on a trusted computer. It supports room collaboration and recording, but the hosted revision workflow requires the separate backend and worker below. A website URL does not provide source access.

`PORT`, `HOST` and `REVIEW_ROOM_DATA_DIR` configure the listener and storage. Unauthenticated mode rejects non-loopback binds. For secure mode configure `REVIEW_OWNER_PASSWORD` through a private secret store and `REVIEW_PUBLIC_ORIGIN` with your exact HTTPS origin. Production startup requires both. Never commit environment files, passwords, invite links or recordings.

See [server configuration](server/README.md), [local deployment configuration](deploy/README.md), [hosted backend setup](vercel-backend/README.md) and [revision worker prerequisites](switch-host/README.md). Configuration names in these guides are placeholders for your own environment; no credentials are distributed.

## Limits and data handling

- This is an early private-beta implementation, not a multi-tenant production service or verified identity system. Invitations are transferable bearer links. Local server sessions live in memory and are lost on restart.
- Browser and network support varies. Screen and microphone permission are required; audio availability depends on captured streams. Some sites block iframe embedding. Separate participant iframe navigation is not synchronized. Real networks may require a separately provisioned TURN relay.
- Browser recording recovery uses IndexedDB on the recording device; quota, private browsing, interruption or cleared storage can prevent recovery. Clock differences and event delivery delays can affect marker timing. Synthetic tests do not prove a real human cross-device call.
- Local uploads are capped at 100 MiB, with an 80 MiB recorder stop target; a final chunk can still exceed the limit. Secure local storage caps recordings at 256 MiB. Hosted storage has separate bucket, reservation and retention limits described in its guide.
- Revision editing accepts one self-contained HTML document up to 150 KiB. It is not a general repository editor. The sandboxed preview blocks scripts, external requests, forms and nested frames, so interactive sites may not behave like their live version.
- The revision worker needs an available operator-managed machine, external tools and separately authorized services. This repository does not provision them or install a background service automatically.
- Recordings, notes, source and worker artifacts can contain client information. Operators must arrange consent, access, backups, retention and deletion. Signed hosted media URLs may remain valid briefly after access is revoked.

## How Review Room uses Switch

For freelancers and small studios, Switch keeps an explicitly shared client review package, the coding agent's exact-diff discussion and the authorized human approval in one room/thread. The optional [Switch bridge](switch/README.md) uses Switch's documented SSE-in / HTTP-out protocol and the existing Review Room proposal/hash gate. With Switch off, the normal room, replay and owner workflow remains unchanged.

Use Switch Console to manage Docker and its bundled Mattermost; configure an isolated room with the original [room template](switch/review-room.template.yaml), reviewer/coding agents and freelancer/client users. Provision a dedicated agent token privately, configure the environment names in the bridge guide, then deliberately start `npm run switch:bridge -- --share switch/.local/package.json`. A token alone never shares a review.

The bridge posts an opted-in finished package's transcript, sanitized collage link and replay URL, asks the coding agent to review the existing exact diff, and waits for an allowlisted human in that exact thread to approve the review ID and hashes. It preserves backend owner authorization and the private preview; guests and agents cannot approve. No second model rewrite runs after approval.

This is a manual adapter for an existing proposed revision, not automatic browser submission. Nineteen synthetic bridge tests pass. Docker was available, but live Switch/Mattermost delivery, template import and preview completion were not runtime-tested; no demonstration screenshot was captured. See the bridge guide for setup, safeguards and full limits.

## Checks

```sh
npm test
node --test vercel-backend/*.test.js
python3 -B -m unittest discover -s switch-host -p '*_test.py'
node --test server/metered-turn.test.js tools/prune-orphan-recordings.test.js
```

The backend tests use mocks and a local PostgreSQL-compatible test engine. They do not verify live Supabase policies, Vercel streaming, TURN connectivity, backups or production capacity. Python worker tests require Python 3.9+ and the `websockets` package (15+). [Storage maintenance](tools/STORAGE-MAINTENANCE.md) is an explicit operator action.

## License

Original project source is available under the [MIT License](LICENSE), copyright 2026 Vasu Bansal. Dependencies retain their own licenses; see [dependency notices](THIRD_PARTY_NOTICES.md). Credentials, runtime data, internal reports, historical probes and reference assets are excluded from this source release.
