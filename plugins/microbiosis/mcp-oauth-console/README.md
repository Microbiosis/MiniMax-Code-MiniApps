# MCP OAuth Console

[简体中文](README.zh-CN.md) | English

Sign in to MCP servers that require OAuth: runs the authorization-code + PKCE flow in your browser, keeps the token out of the page, writes the `Authorization` header into the MiniMax Code MCP configuration, and refreshes it before it expires.

Author: [Microbiosis](https://github.com/Microbiosis) · Version: `1.0.0`

## Install & use

Copy this directory into the active MiniMax Code data directory under `plugins/`. `<dataDir>` defaults to `~/.minimax`, so the default install path is:

```text
<dataDir>/plugins/mcp-oauth-console/
```

Keep the hidden `.minimax-plugin/` directory. Restart MiniMax Code, confirm the plugin is recognized, then open "MCP OAuth 令牌台" from the plugin list or by asking the assistant.

The page lists every MCP server in the MiniMax Code configuration and shows **two independent facts** per server: what the *server* demands (probed from the endpoint) and what *this machine* holds (the credential in the local configuration). A server can require OAuth and still be satisfied by a local token; a server can need no OAuth and still have no token. Keeping them apart stops either one from hiding the other.

| Action | What it does |
|---|---|
| Detect | Re-probes the endpoint with a handshake that matches the declared transport, and shows the result in that server's own row |
| Authorize | Runs the authorization-code + PKCE flow: dynamic client registration, browser consent, callback, then a confirmation dialog showing exactly which field will change |
| Confirm write | Patches `mcpServers.<name>.headers.Authorization` in `mcp.json`, backs the file up first, then verifies the token with a real MCP handshake |
| Refresh | Exchanges the stored refresh token for a new access token and writes it back |
| Refresh expiring | Refreshes every stored token that is within 30 minutes of expiry |

## How detection works

The probe uses the transport the server declares in the configuration:

- `streamable-http`: a real `initialize` JSON-RPC call.
- `sse`: a `GET` that opens the event stream. A `POST` to the `/sse` URL is not a valid call for that transport and answers `405`.

A `401` on its own is **not** treated as OAuth. Only a `WWW-Authenticate: Bearer resource_metadata="…"` challenge is read as a declaration of OAuth, because that is how an MCP server points at its authorization server (RFC 9728). The page therefore distinguishes:

| Result | Meaning |
|---|---|
| Requires OAuth | `401` plus a discoverable authorization server. The browser flow can run. |
| Requires a Bearer credential | `401` plus a Bearer challenge, but no `resource_metadata`. No authorization server can be discovered. |
| Requires a credential, scheme undeclared | `401` with no usable challenge. The endpoint wants *some* credential — an API key, for example — not necessarily OAuth. |
| OAuth not required | An unauthenticated handshake was accepted. |
| Undetermined | The endpoint answered with something else (`404`, `405`, `5xx`) or could not be reached. |

When a server does not declare OAuth the browser flow is not offered: there is no authorization server to run it against, so the header has to be set by hand instead.

## Data & access

### Files read

| File | Why |
|---|---|
| The MiniMax Code MCP server configuration (`mcp.json`) | The list of servers to inspect, and the header to write. |

`mcp.json` is a Host file with no supported API for plugins. This plugin locates it by walking up from `context.dataDir`, then from the process working directory, then from the directory of the Node executable, and finally falls back to `~/.minimax/mcp.json`. **This relies on an unspecified layout**: on a Host that keeps the configuration somewhere else, the plugin finds no servers and shows an empty list.

A credential directory left next to `mcp.json` by an earlier version of this plugin is read once and imported into `context.dataDir`. It is never written to again.

### Files written

| File | What |
|---|---|
| `mcp.json` | Only the `Authorization` header of one server entry. The patch is surgical: the rest of the file stays byte-identical. |
| `<dataDir>/mcp-credentials/<server>.json` | The credential: client id, client secret, refresh token, access token, scope, expiry. |
| `<dataDir>/mcp.json.bak` | A copy of `mcp.json`, taken before every write. |

Writes to `mcp.json` are atomic: a temporary file in the same directory, then a rename. The original file mode is carried over, because a temp file starts with the default mode. Writes are serialized so two of them cannot interleave. If a write fails the temporary file is removed and the previous content stays intact.

### Network hosts

The plugin talks to exactly two kinds of hosts:

1. The MCP endpoints listed in the MCP configuration — for the detection probe and for the post-write verification handshake.
2. The OAuth endpoints of those servers, taken from their metadata: the authorization endpoint, the token endpoint, the protected-resource document, and the `.well-known` authorization-server metadata.

Nothing else is contacted. There is no telemetry, no analytics, and no third-party service.

A target URL is validated before the process requests it: `https` only (plain `http` is accepted for loopback addresses), no credentials inside the URL, and instance-metadata or link-local addresses are refused.

### Spawned processes

| Command | When |
|---|---|
| `explorer.exe <authorization-url>` (Windows) or `open <authorization-url>` (macOS) | Once per authorization, to open the consent page in the default browser. |

Arguments are passed as an argv array and never through a shell. The URL is the authorization request built from the server's own metadata.

### Where state is stored

All durable state lives under `context.dataDir`, the private directory the Host creates for this plugin. Nothing is written outside it except the MCP configuration listed above.

### Credentials

Token material stays in the Node process. The page receives metadata only: scope, expiry, and an eight-character SHA-256 fingerprint used to tell two tokens apart. A fingerprint is not reversible and is not usable as a credential. Credentials are never placed in HTML, client JavaScript, log messages, or error responses.

## Tested environment

| | |
|---|---|
| MiniMax Code | 3.1.6 (Windows) |
| Platform | Windows 11, Node 22 or newer |
| Authorization servers | Hugging Face OAuth (`huggingface.co`), Exa OAuth (`auth.exa.ai`) |
| Verified flows | Dynamic client registration, authorization code + PKCE (S256), authorization code exchange, refresh token exchange, MCP `initialize` handshake after a write |

Verified end to end against the Hugging Face authorization server and the Hugging Face Inference Endpoints MCP server.

## Known limitations

- The plugin can only manage servers that are already in the MCP configuration, or that you add through the page. It does not discover servers on its own.
- A server that needs a credential but does not declare OAuth cannot be signed in to from the page; the header has to be set by hand.
- The detection probe checks the handshake. A server may accept an unauthenticated `initialize` and still require a token for tool calls.
- The refresh timer runs while the Mini App is running. A token that expires while the app is stopped is refreshed the next time it starts.

## License

Apache-2.0. See [LICENSE](LICENSE).
