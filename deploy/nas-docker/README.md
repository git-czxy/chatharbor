# ChatHarbor on NAS (Docker)

This branch records the NAS Chromium deployment used to run the ChatHarbor userscript. It does not add a ChatHarbor application server.

## Archive layout

Set `CHATHARBOR_ARCHIVE_HOST_PATH` to the host directory mounted at `/data/conversations/chatgpt`. The archive root contains:

```text
conversations/
projects/
reports/
ChatHarbor_manifest.json
```

Keep both `conversations/` and `projects/`: the Manifest stores paths into each tree. Omitting `projects/` makes project conversations appear missing during local checks.

## Configure and run

1. Copy `.env.example` to `.env`, set the real NAS archive path, and choose a trusted LAN bind address only if remote browser access is needed. `.env` is ignored by Git.
2. Ensure the archive directory exists and is writable by the configured UID/GID. Do not fix access with recursive ownership or ACL resets. The Compose bind uses `create_host_path: false` so a typo will fail instead of creating an empty archive.
3. Use the existing Compose project name to preserve the named browser Profile and source volume:

   ```sh
   docker compose -p chatharbor-nas-pilot --env-file .env -f compose.yaml up -d
   ```

4. Create the Web Authentication account interactively; enter its password only at the hidden prompt:

   ```sh
   docker exec -it chatharbor-nas-pilot webauth-user add operator
   ```

5. Open the authenticated Chromium page, install `ChatHarbor.user.js`, sign in, then set its archive directory to `/data/conversations/chatgpt`.

The checked-in userscript is the NAS-tested v0.0.14.5.1 candidate (SHA-256 `1e2bf8bb6696e99ba31d06f49b444964cc8ff26da57d8563fec5cafc37d7b328`). It is stored here as a deployment artifact; the upstream application source on this branch remains unchanged.

The bind address defaults to loopback. If binding to the NAS LAN address, keep access on a trusted network and do not expose the port directly to the Internet. Do not put passwords in Compose, `.env`, Git, or command arguments.

## Persistent volumes

- `chatharbor-nas-pilot_browser-profile`: Chromium profile and login state.
- `chatharbor-nas-pilot_data-posix-pilot`: original archive recovery source. The running deployment mounts this volume read/write for compatibility; do not select it as the active ChatHarbor archive after cutover.
- NAS bind directory: active conversations, project conversations, reports, and Manifest.

Do not run `docker compose down -v` or remove either named volume. Backups and restore tests must be handled separately.

The image is pinned to `jlesage/chromium:v26.09.2` and its resolved digest. Update the pin only after a separately verified upgrade.
