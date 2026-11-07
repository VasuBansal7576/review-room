# Optional Switch review bridge

This is an original, opt-in Node.js adapter for freelancers and small studios who want client feedback and their coding agent in one chat thread. It reuses the existing Review Room hosted revision proposal, canonical hash validation and owner-only approval endpoint. It does not replace the established Switch-connected Python revision worker or weaken guest permissions.

## Verified protocol references

Read the upstream [agent protocol](https://docs.switchagents.ai/flintai/switch/internals/agent-protocol), [operation definitions](https://github.com/sandbox-quantum/switch/blob/main/core/switch_core/bridges/agent/operations/definitions.py), and [template schema](https://github.com/sandbox-quantum/switch/blob/main/docs/TEMPLATES.md). The former `docs/protocol` path returned 404; the current repository document is `docs/official/internals/agent-protocol.md`.

The adapter discovers `GET /agents/{agent_id}/ops`, opens `GET /agents/{agent_id}/events` with `connection_id`, `scope=single`, `filter=all`, `start_from=head` and the configured `rooms`, validates `connection_state`, and sends `POST /agents/{agent_id}/connection/beat` every two seconds with its cursor. Operations use `POST /agents/{agent_id}/ops/{name}`, raw argument objects and `X-Switch-Connection-Id`. Every request uses the agent API key as a bearer credential. It uses `connect_to_room({room_id})`, `list_participants({})`, `post_message({body,thread_id?})` and `send_targeted_message({body,target_names,thread_id})`. The returned `event_id` anchors the review thread. Existing `server/switch.js` uses the documented simpler `/message` route; that workflow is unchanged.

No membership mutation occurs: the dedicated reviewer must already belong to the configured room. Room claims can displace another connection for that same agent, so use a dedicated identity and do not run its Console-managed provider session concurrently. A stream gap, eviction, lost claim, heartbeat failure or disconnect stops approval processing. Automatic reconnect/history reconciliation is deliberately not implemented yet.

## Setup and explicit sharing

Use [Switch Console and the quickstart](https://docs.switchagents.ai/) to manage a local Docker server and its bundled Mattermost. The [hackathon resources](https://www.wemakedevs.org/hackathons/switch) link the official quickstart, Console and examples. Do not expose ports or use a shared room merely to test this adapter.

`review-room.template.yaml` is original configuration using the documented version-1 schema: two agents and explicit freelancer/client messaging usernames in a private room. Import it through Console only when authorized to create that room. Template agents are Console-managed by default. For the deterministic reviewer bridge, separately provision its agent API key through the documented registration flow and use that dedicated room member; do not assume Console exports credentials or that model instructions enforce approval. The template is not automatically installed by this repository and was not runtime-imported here.

Set the following privately; values below are descriptions, not credentials:

| Variable | Meaning |
| --- | --- |
| `REVIEW_SWITCH_ENABLED` | Must be exactly `true`; otherwise no network work occurs |
| `SWITCH_AGENT_BASE_URL` | Your Switch **agent bridge** origin, not its Gateway URL |
| `SWITCH_AGENT_ID` | Dedicated registered reviewer agent ID |
| `SWITCH_AGENT_API_KEY` | Its private API key, never a registration token |
| `SWITCH_ROOM_ID` | Existing isolated room UUID |
| `SWITCH_CODING_AGENT_NAME` | Exact coding-agent roster name; never `everyone` |
| `SWITCH_HUMAN_APPROVERS` | Comma-separated complete opaque participant IDs for authorized human owners |
| `REVIEW_PUBLIC_ORIGIN` | Your Review Room HTTPS origin |
| `REVIEW_OWNER_COOKIE_FILE` | Mode-0600 file holding an existing authorized owner's Cookie header value |
| `REVIEW_SWITCH_STATE_DIR` | Optional private journal directory; defaults to ignored `switch/.local` |

Do not parse participant IDs to infer humanity. The bridge requires both the explicit allowlist and a fresh roster entry with `type: user`. Client participation alone grants no approval authority. The owner deliberately delegates this narrow action by supplying their existing cookie; it expires or is revoked normally. No password login, session creation, guest bypass or unauthenticated apply is attempted.

Create a mode-0600 local JSON package file outside published source, for example `switch/.local/package.json`. Required fields are `shareWithSwitch: true`, `finished: true`, `reviewId` (existing backend revision ID), `roomId` (Review Room ID, distinct from Switch room), `transcript`, `collageURL` and `replayURL`. Both URLs must be HTTPS. Query strings and fragments are removed; invitation-like paths are withheld. Review the entire transcript before opting in: free text can contain private client information. The bridge does not upload collage/media or grant access to their URLs.

```sh
npm run switch:bridge -- --share switch/.local/package.json
```

Neither a token in the environment nor finishing a browser recording starts sharing. Each package needs its explicit consent and a deliberate command. Browser automatic submission is not wired in this release.

## Package, exact diff and human approval

First prepare a revision through the existing owner UI and Switch-connected worker. This adapter currently requires that revision to be `proposed`. It posts the finished package, addresses the coding agent in the same thread with the backend's hashes and a sanitized diff display (URLs and mentions are neutralized; the exact diff remains in the authenticated Review Room), and asks it to review that diff. Proposed changes must return through the existing revision workflow; arbitrary agent chat cannot supply replacement source.

The human command is `approve REVIEW_ID PROPOSAL_HASH HTML_SHA256`, using all exact values posted in that thread. Bare `approve`, other users, agent/platform messages, other rooms/threads, stale timestamps and changed hashes do nothing. Approval re-fetches the authenticated backend proposal, re-runs the existing canonical parser, and compares the complete input/proposal snapshot. The proposal hash binds the original source and proposal; HTML SHA256 binds the exact output bytes.

A private durable journal reserves each review before sharing and consumes its approval before the owner-authenticated `POST /api/rooms/{room}/revisions/{review}/approve`. The normal Origin and owner-cookie checks remain mandatory. The existing worker then materializes approved bytes without a second model call; the usual authenticated Review Room preview remains the destination. The bridge never calls an unauthenticated preview/apply route or publishes HTML in chat. It reports acceptance, not preview completion. Repeat runs of a reserved review fail closed, including after crashes; inspect backend state manually rather than deleting the journal and blindly retrying.

## Actual status and limits

Nineteen synthetic adapter tests cover protocol requests, SSE framing, consent, URL redaction, exact-byte approval, unauthorized/agent/wrong-thread/stale/duplicate denial, changed proposals and owner rejection. Run `npm run test:switch`. The original 73-test main suite, 11 backend tests and 18 Python worker tests remain separate. No screenshots or runtime receipts are fabricated.

Docker 29.1.3 was confirmed running during preparation. No Switch room, account, membership or container was changed; no local Mattermost demonstration or live end-to-end bridge test was performed. Runtime interoperability and template import remain unverified. The adapter handles one explicitly selected proposed revision per process, limits its diff to 32,000 bytes, and stops on delivery discontinuity. It is a manual integration, not a fully automatic browser-to-chat pipeline.

Upstream Switch is referenced, not copied or vendored. Its own license and dependency terms apply to separately obtained installations; no blanket MIT claim is made for it. This adapter and template are original Review Room source under this repository's MIT license.
