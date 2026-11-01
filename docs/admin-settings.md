# Manage the shared service

The optional `/mcp/admin` endpoint exposes three tools to a separately authenticated management client. It configures **this MCP service**, not the Mattermost server. The ordinary `/mcp` and stdio catalogs do not include these tools.

The `limits` section of `list_settings` reports operator ceilings without revealing paths or secrets. Change bootstrap options through the service environment; do not pass credentials in an MCP call.

## Connect from OpenCode

1. In a private directory, generate a fresh admin bearer: `(umask 077; openssl rand -hex 32 > admin-token)`. Use an unused filename. Keep this token separate from the normal HTTP bearer and the Mattermost PAT. Its file must be outside every `MM_UPLOAD_ROOTS` directory.
2. Set `MM_ADMIN_TOKEN_FILE` to that file's absolute path in the service environment and restart the service once. Without this setting the admin endpoint is disabled.
3. Add the following to the **project-local** `opencode.json` of a private management workspace. Adjust the file reference and port to match the service. Leave this entry out of global OpenCode configuration and the tunnel bridge.

```json
{
  "mcp": {
    "servers": {
      "mattermost_admin": {
        "type": "remote",
        "url": "http://127.0.0.1:8766/mcp/admin",
        "oauth": false,
        "headers": { "Authorization": "Bearer {file:~/.local/share/mattermost-mcp/admin-token}" }
      }
    }
  }
}
```

The admin bearer cannot call message tools; the normal bearer cannot call admin tools. The project boundary controls which clients get the management connection. As with other owner-only files, it is not a sandbox against processes running as the same OS user.

## List, set, reload

| Tool              | Arguments                     | Effect                                                                                                                                                      |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_settings`   | `{}`                          | Show values, application mode, revision and credential status. No secret values.                                                                            |
| `set_settings`    | `{patch, expected_revision?}` | Validate and persist a nonempty patch, apply live fields, and report any pending restart. Use `null` to remove an override and restore its bootstrap value. |
| `reload_settings` | `{expected_revision?}`        | Reread configured private files and apply valid changes without restarting the process. An invalid candidate is rejected.                                   |

**“Set retention to 72 hours.”** In the management workspace:

```js
const { revision } = await tools.mattermost_admin.list_settings({});
return await tools.mattermost_admin.set_settings({
  patch: { retention_hours: 72 },
  expected_revision: revision,
});
```

In the response, `settings.<key>.value` is active, `desired` is persisted, and `restart_required` lists differences that require a restart. The revision identifies the non-secret overrides, not the secret values. There is no second reload step after a successful set. To restore the operator's retention default, use `patch: { retention_hours: null }`. When another writer has changed the revision, reread the settings and check the intended change before retrying.

| Setting                                                      | Behavior                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention_hours`                                            | Live, 1–168 hours (default 48; bootstrap `MM_RETENTION_HOURS`). Shortening immediately prunes older cached content. Extending backfills still-accessible Mattermost history over the larger window. |
| `events_enabled`                                             | Enable or disable the cache, listener and subscription tools. Reconnect a client if it caches the old tool catalog.                                                                                 |
| `read_only`, `allow_destructive`                             | Live write guardrails. Read-only pauses callback delivery; unexpired leases can resume for eligible cached posts when writable again. Destructive calls still need per-call confirmation.           |
| `max_message_len`, `max_upload_bytes`, `http_max_body_bytes` | Limits for new outgoing messages (characters), upload payloads (bytes) and ordinary MCP request bodies (bytes).                                                                                     |
| `request_timeout_ms`, `max_retries`, `retry_base_ms`         | Request timeout, safe-read retry count (0–10) and initial delay (1–60000 ms). A zero request timeout disables the configured Mattermost request timeout.                                            |
| `http_port`                                                  | **Restart required.** The desired port is persisted, but the current socket stays bound. Coordinate the restart and update both client URLs.                                                        |

Overrides are a flat owner-only JSON object in `MM_SETTINGS_FILE` (absolute path; default `$XDG_STATE_HOME/mattermost-mcp/settings.json` or `~/.local/state/mattermost-mcp/settings.json`). The file stores only the listed settings. Configure origins, filesystem roots, resource allowlists, secret source paths and other bootstrap variables in the service environment; changes to that environment or its systemd unit require a restart. Live reload reads the configured **files**, not a changed supervisor environment.

## Rotate credentials without putting secrets in chat

For reloadable PAT authentication, configure `MM_AUTH_MODE=pat`, an explicit `MM_URL`, and `MM_TOKEN_FILE` pointing to an owner-only file. Its value takes precedence over a bootstrap `MM_TOKEN`. For an existing multiline private file, `MM_TOKEN_FILE_LINE` selects the positive, one-based line containing the token. Prefer a single dedicated token file for a new installation.

Update the file through your normal secret management path; do not paste the token into a tool argument. Then ask **“Reload my rotated Mattermost PAT.”** The tool call is `reload_settings({})`. The service verifies the replacement against the configured Mattermost origin and authenticated account before switching and reconnecting the event listener. An invalid token or a different account does not replace the working session.

Reload also picks up changes to file-backed MCP bearers and configured callback credentials/destinations. Existing leases for removed callback destinations are revoked. After rotating an HTTP or admin bearer, reconnect clients so their file-backed Authorization headers use the new value. A retained old client bearer no longer grants access after reload. No management tool returns a bearer, reads arbitrary file paths, or accepts a raw token.
