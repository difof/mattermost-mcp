# mattermost-mcp

Use your Mattermost account from an MCP agent: read conversations, send DMs and replies,
manage channels, and work with files. **34 tools**, stdio transport, Node.js 20+.

This is [difof's fork](https://github.com/difof/mattermost-mcp) of
[BryanBerger98/mattermost-mcp](https://github.com/BryanBerger98/mattermost-mcp), with fixes for
personal-account automation through Mattermost REST API v4.

## Quick start

```bash
git clone --branch master https://github.com/difof/mattermost-mcp.git
cd mattermost-mcp
npm ci
npm run build
node dist/index.js login
node dist/index.js status
```

Choose **PAT** in the login wizard and use your own account's token. Credentials are saved locally
with owner-only permissions and tied to the server URL. Password, OAuth2 and browser SSO are also
supported; see [authentication and configuration](docs/configuration.md).

Add this to your agent harness's MCP configuration, using an absolute path:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["/absolute/path/to/mattermost-mcp/dist/index.js"]
    }
  }
}
```

The process uses the saved login. For environment-based credentials, see
[the example configuration](examples/mcp.json). Run `node dist/index.js logout` to remove the login.

**Install this fork from source.** The upstream npm package does not include this fork's changes.

## What it covers

| Area               | Tools | Capabilities                                                              |
| ------------------ | ----: | ------------------------------------------------------------------------- |
| Messaging          |    13 | History, threads, search, messages, DMs/groups, edits, pins and reactions |
| Channels and teams |    12 | Listings, channel creation, membership, unread counts and read state      |
| Users and presence |     6 | User lookup, search, identity and status                                  |
| Files              |     3 | Upload, metadata and bounded downloads                                    |

A PAT uses your account's permissions. These tools cover a subset of the Mattermost API;
see [the API coverage audit](docs/api-coverage.md) for the complete endpoint inventory and gaps.

Writes are enabled by default. Set `MM_READ_ONLY=true` to disable them. Deletes, archives and
member removal additionally require `MM_ALLOW_DESTRUCTIVE=true` and `confirm: true` per call.
[Team/channel restrictions and retry behavior](docs/configuration.md#guardrails) are configurable.

## Development

```bash
npm test             # unit tests + mocked API workflows; live tests skipped by default
npm run test:mocks   # real MCP → Client4 → local HTTP mocks
npm run build
npm run lint
```

The mocked tests use synthetic accounts and a local HTTP server. They exercise the actual MCP and
HTTP stack; real server permissions and deployment behavior still need live validation.

## Documentation

- [Tool reference and personal-account workflows](docs/tools.md)
- [Authentication, configuration and guardrails](docs/configuration.md)
- [Testing, mock design and optional live checks](docs/testing.md)
- [Mattermost API coverage and missing capabilities](docs/api-coverage.md)

## License

MIT. Original author: Bryan Berger.
