# Reference provider (development only)

`server.mjs` is a **local, single-file reference implementation** of the provider
side of the Line Launcher contract. It exists so a desktop build can be exercised
end to end without a production backend.

> **Never deploy this file.** Accounts are in memory, the password check is a
> demo comparison, tickets are stored in a `Map`, and the TLS certificate is
> self-signed. It implements the _protocol_, not production security.

## What it implements

| Endpoint                              | Contract                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /config.json`                    | Schema 1 config with ETag/304, pointing at the generated pack                            |
| `GET /pack.zip`                       | The immutable archive whose SHA-256 is published in the config                           |
| `POST /v1/login`, `POST /v1/register` | `{username, password}` → `{access_token, expires_in, username}`; one account per project |
| `POST /v1/launcher/ticket`            | Bearer session → one-shot `{ticket, expires_in}` bound to server/release/channel/user    |
| `POST /v1/launcher/exchange`          | Consumes the ticket once; rejects replay (409), expiry (401), binding mismatch (403)     |

Every rejected exchange is logged with a reason, which makes it usable as an
oracle during manual desktop testing.

## Run

The easy path is one command from the repository root — it builds the demo,
bakes the address, starts this provider, runs the desktop app with the local
certificate trusted, and restores `branding/provider.json` on exit:

```sh
npm run demo              # provider + app
npm run demo:check        # verify this provider over HTTPS, no JDK/Rust needed
npm run demo:update       # publish the second release (update + rollback)
```

See [docs/DEMO.md](../../docs/DEMO.md) for the click-through checklist. The
manual steps below are for controlling each part separately:

```sh
node examples/provider/build-pack.mjs      # writes .provider/pack*.zip + config
node examples/provider/server.mjs          # https://127.0.0.1:8443/config.json
```

Requirements: Node 22+, `openssl` (for the self-signed certificate; auto-detected,
including the copy bundled with Git for Windows — override with `LINE_OPENSSL`), and a JDK
17+ (`javac`) or `ECJ_JAR` to compile the demo mod client. The pack contains a
real `line-launch.json` and a `client.jar` whose main class requests the ticket
over the private IPC channel and exchanges it — i.e. the launcher's real launch
path is exercised without Minecraft.

Because the certificate is self-signed, the desktop app rejects it until you
trust it. The launcher reports this as `TLS_UNTRUSTED` ("Не удалось проверить
сертификат провайдера"), not as a connectivity problem. To confirm the server
itself is fine:

```sh
curl --cacert .provider/tls.crt https://127.0.0.1:8443/config.json
```

The least invasive fix trusts the certificate for the launcher process only,
without touching the OS trust store or needing administrator rights:

```sh
LINE_DEV_CA_CERT=.provider/tls.crt npm run tauri dev -- --features dev-provider-ca
```

That cargo feature is off by default and must never be enabled in a distributed
build. macOS cannot take extra roots this way — use the OS trust store there.
Both routes, and the risks of the machine-wide one, are in `docs/RUNBOOK.md`,
section 3.2.

## Files

- `build-pack.mjs` — compiles `DemoGame.java` + the reference `LineTicketClient`,
  builds `client.jar`, writes the manifest and three archives (two Demo Survival
  releases plus Demo Creative), generates server artwork and two ready-made skin
  PNGs, and prints the hashes. `--no-java` builds an install-only demo when no
  compiler is available.
- `DemoGame.java` — minimal main class: requests the ticket, exchanges it, prints
  a redacted result, exits with 0 on success and 1 on failure.
- `server.mjs` — the HTTPS provider described above. It re-reads `config.json`
  per request, so a release can be published while it runs.
- `publish-release.mjs` — switches Demo Survival between the two published
  releases; the launcher then sees a new version and the old one stays available
  for rollback.
- `DemoGame.java` stays alive for `LINE_DEMO_SECONDS` (default 20) after the
  handshake so the stop button can be exercised; the launcher keeps its output in
  `instances/<server>/logs/launch.log`.
- Output goes to `.provider/` (gitignored, override with `LINE_PROVIDER_DIR`).
