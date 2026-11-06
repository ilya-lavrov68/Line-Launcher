# Reference provider (development only)

`server.mjs` is a **local, single-file reference implementation** of the provider
side of the Line Launcher contract. It exists so a desktop build can be exercised
end to end without a production backend.

> **Never deploy this file.** Accounts are in memory, the password check is a
> demo comparison, tickets are stored in a `Map`, and the TLS certificate is
> self-signed. It implements the _protocol_, not production security.

## What it implements

| Endpoint                              | Contract                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /config.json`                    | Schema 1 config with ETag/304, pointing at the generated pack                         |
| `GET /pack.zip`                       | The immutable archive whose SHA-256 is published in the config                        |
| `POST /v1/login`, `POST /v1/register` | `{username, password, server_id}` → `{access_token, expires_in, username}`            |
| `POST /v1/launcher/ticket`            | Bearer session → one-shot `{ticket, expires_in}` bound to server/release/channel/user |
| `POST /v1/launcher/exchange`          | Consumes the ticket once; rejects replay (409), expiry (401), binding mismatch (403)  |

Every rejected exchange is logged with a reason, which makes it usable as an
oracle during manual desktop testing.

## Run

```sh
node examples/provider/build-pack.mjs      # writes .provider/pack.zip + config
node examples/provider/server.mjs          # https://localhost:8443/config.json
```

Requirements: Node 22+, `openssl` (for the self-signed certificate), and a JDK
17+ (`javac`) or `ECJ_JAR` to compile the demo mod client. The pack contains a
real `line-launch.json` and a `client.jar` whose main class requests the ticket
over the private IPC channel and exchanges it — i.e. the launcher's real launch
path is exercised without Minecraft.

Because the certificate is self-signed, the desktop app will reject it until you
trust it. See `docs/RUNBOOK.md`, section “Локальный провайдер”.

## Files

- `build-pack.mjs` — compiles `DemoGame.java` + the reference `LineTicketClient`,
  builds `client.jar`, writes the manifest and the archive, prints the hashes.
- `DemoGame.java` — minimal main class: requests the ticket, exchanges it, prints
  a redacted result, exits with 0 on success and 1 on failure.
- `server.mjs` — the HTTPS provider described above.
- Output goes to `.provider/` (gitignored).
