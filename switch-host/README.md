# Revision worker

The optional Python worker polls durable revision jobs from the hosted backend, sends the selected context through an operator-provisioned Switch Core instance, and invokes a coding agent after matching addressed delivery. It needs no inbound tunnel. This source release does not provision Switch or install an operating-system service.

Prerequisites: Python 3.9+, `websockets` 15+, ffmpeg, whisper-cli with a separately obtained Whisper model, and an authenticated Codex CLI compatible with the worker's restricted invocation. External tools and models retain their own licenses. Inspect `revision-worker.py --help` for configuration; defaults expect private state in `switch-host/.local/`.

Provision a Switch sender, revision agent and room using your own authorized installation. Supply private `sender.json`, `revision-agent.json` and `room.json` files with the IDs and API fields issued by that installation. The worker reads their credentials locally; these files are not included. Restrict directories to mode 0700 and credential files to 0600. Configure the agent's addressing policy for the intended sender and room. Put the Whisper model in the configured model path.

Example with a placeholder origin:

```sh
python3 -B switch-host/revision-worker.py --app-origin https://review.example.invalid --mention @review-room-revisions --check
```

Use `--help` to select identity files, model and state paths. An authorized owner must bootstrap the worker session using the private owner-password file option. Remove `--check` only when authorized to process jobs. Do not run competing workers with the same session state.

The session can claim jobs, heartbeat and finish its own fenced claims; it cannot approve revisions. Revocation stops processing and requires explicit owner reauthorization with `--reauthorize`. Apply materializes only the approved proposal and verifies its SHA-256 hash without another model invocation.

Job directories contain private recordings, derived audio, frames, source proposals and approved HTML. They remain until the operator removes them. Keep them outside published source and arrange retention. The worker must remain running; it is not an independent hosted agent service. The included proxy supports the older optional text handoff, which is separate from revision execution.

Run isolated behavior checks with `python3 -B -m unittest discover -s switch-host -p '*_test.py'`. These tests do not establish compatibility with every external CLI version or provision a real Switch service.
