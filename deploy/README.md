# Deployment bundle

This bundle prepares a single-server deployment with persistent room and recording storage and a Caddy HTTPS reverse proxy. The application has owner sign-in and expiring guest invitations. A hosted deployment, a live TURN relay, reliable backups, and a session between people on separate networks remain unverified.

No server is provisioned by these files. The Compose configuration binds the proxy to this computer's loopback interface only. Do not change those bindings to a public interface until the application and deployment have appropriate access controls.

## What the bundle contains

The app container runs as an unprivileged Node user. Only application files enter the image; the local `data/` directory, test recordings, and credentials are excluded by `.dockerignore`. The `review_data` named volume holds room JSON and recordings across container restarts. `caddy_data` holds Caddy certificate state. The app port is only accessible to the proxy over the Compose network, not directly published to the host.

`deploy/Caddyfile` forwards requests, including the room's long-lived event stream, to the app. Caddy manages certificates for qualifying hostnames. Its localhost certificate is not automatically trusted by other devices.

## Local-only preparation

From the project directory, inspect the Compose configuration without starting any service:

```sh
docker compose -f deploy/compose.yaml config
docker compose -f deploy/compose.yaml build
```

Starting the bundle would expose ports only on `127.0.0.1` with the defaults. The Caddy-generated local certificate requires explicit trust on a client. Do not bypass browser certificate warnings.

For a remote deployment, use a domain controlled by the operator, a trusted TLS certificate, persistent storage and backups, and configure the proxy's interface and public ports on the chosen host. Caddy's automatic certificate issuance requires public DNS and reachable challenge ports unless another supported challenge is configured. Keep the app's HTTP port private behind the trusted proxy. Review host firewall rules, certificate renewal, backup and restore, access control, and actual user sessions before relying on it.

## Media and optional Switch settings

The app uses its default STUN server unless configured otherwise. Real client networks often need TURN. For a separately provisioned coturn server using REST shared-secret authentication, configure `TURN_URLS_JSON` with a JSON array of TURN URLs and keep `TURN_SHARED_SECRET` secret. The shared secret must be at least 32 bytes. `TURN_CREDENTIAL_TTL_SECONDS` is optional and accepts 300 to 86400 seconds, with a default of 3600. The server generates short-lived credentials for authorized room members; the shared secret itself must never be sent to the browser. This bundle does not provision TURN or prove relay connectivity.

`ICE_SERVERS_JSON` configures additional ICE servers. Secure mode rejects static TURN entries in this setting. For Cloudflare Realtime TURN, set `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, and optionally `CLOUDFLARE_TURN_TTL_SECONDS`. Configure only one TURN provider. Store provider secrets in the deployment platform's secret manager. See [the server reference](../server/README.md) for accepted values. When using Compose, check that the provider variables are passed to the app container.

The four `SWITCH_*` sender settings are optional. Treat API keys as secrets and supply them through the deployment platform's secret manager. Compose environment variables can be visible to users with host or Docker access. Do not place secrets in a committed file. The local demo reply listener is not enabled by this bundle and is not a production Switch runtime.

## Managed hosting

A managed host must provide trusted HTTPS and persistent storage mounted at `REVIEW_ROOM_DATA_DIR`. The local server requires one application instance because sessions, subscribers and write queues are in memory. Supply `REVIEW_OWNER_PASSWORD` through the host's secret manager and set `REVIEW_PUBLIC_ORIGIN` to your exact HTTPS origin. Check current platform limits and costs independently before deployment.

## Data handling

Named volumes persist independently of container replacement. Back up and restore `review_data` with appropriate encryption, access controls, and a retention policy. Do not run `docker compose down -v` when you intend to preserve data. Recordings may contain confidential conversations. Secure mode caps recordings at 256 MiB across the server and persisted room data at 64 MiB across rooms. Owners can delete saved recordings; the [orphan maintenance tool](../tools/STORAGE-MAINTENANCE.md) is a separate, manual operator action. Review the platform's storage and backup protections before real clients use the app.
