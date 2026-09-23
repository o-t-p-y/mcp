# @o-t-p-y/mcp

Official Model Context Protocol (MCP) server for [OTPy.ir](https://otpy.ir) — interact with your OTPy account, inspect usage, send test codes, and manage keys directly from AI assistants.

## Two credentials

This server can use up to two different OTPy credentials, each for a different purpose:

| Credential | Env var / flag | What it's for |
|---|---|---|
| **API key** (project-scoped) | `OTPY_API_KEY` / `--api-key` | Authenticates the OTP API and usage calls: `get_usage`, `send_test_otp`, `verify_test_otp`. This is the same `otpy_...` key you use to send real OTPs from your product. |
| **User key** (user-scoped) | `OTPY_USER_KEY` / `--user-key` | Authenticates project reads and provides live scope gating for billing/write tools. This is a separate `otpy_uk_...` secret, obtained from the **Integration** page (`/integrate`) on [dash.otpy.ir](https://dash.otpy.ir). |

The API-key-only tools are `get_usage` and `get_integration_snippet`. Project reads (`list_projects`, `list_otp_messages`) use the enabled user key, while `list_transactions` also requires its `billing` scope. Any tool that requires a user key is denied outright if none is configured.

## Installation / Setup

### Cursor

Add to your `.cursor/mcp.json` or Cursor Settings → MCP:

```json
{
  "mcpServers": {
    "otpy": {
      "command": "npx",
      "args": ["-y", "@o-t-p-y/mcp"],
      "env": {
        "OTPY_API_KEY": "otpy_your_api_key_here",
        "OTPY_USER_KEY": "otpy_uk_your_user_key_here"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "otpy": {
      "command": "npx",
      "args": ["-y", "@o-t-p-y/mcp"],
      "env": {
        "OTPY_API_KEY": "otpy_your_api_key_here",
        "OTPY_USER_KEY": "otpy_uk_your_user_key_here"
      }
    }
  }
}
```

You can also copy the pre-configured MCP snippet (Cursor, Claude Desktop, Windsurf, and Kilo) from your project's **Project Settings** page (`/project-settings`) on [dash.otpy.ir](https://dash.otpy.ir). Create the user key itself on the **Integration** page (`/integrate`).

The server speaks standard MCP over stdio and works with **any MCP-compatible agent** — Cursor, Claude Desktop, Windsurf, and Kilo are configuration examples, not requirements. Likewise, the `get_integration_snippet` tool covers any code stack (Node.js, Python, Go, PHP, cURL, C#) with framework-neutral code.

## Scope model (`user_keys`)

Every user key has exactly two independently toggleable scopes, `write` and `billing`, plus a `root` flag that is always *derived* as `write AND billing` — it is never set directly. There is no third, separately-grantable permission.

| Scope | Grants |
|---|---|
| `write` | `send_test_otp`, `verify_test_otp`, `create_api_key` |
| `billing` | `get_balance`, `list_api_keys`, `list_transactions` |
| `root` (derived: `write` and `billing` both true) | Everything above — not a separate scope, just shorthand for "has both". |

Create a user key with the scopes you need on the **Integration** page (`/integrate`) of [dash.otpy.ir](https://dash.otpy.ir) (create/list/revoke and toggling `write`/`billing` all live there). The raw `otpy_uk_...` secret is shown exactly once at creation time — copy it into `OTPY_USER_KEY` immediately.

### How scope verification actually works

Every call to a `write`- or `billing`-gated tool makes a **real, live network request** to `GET /v1/user-keys/self` on the OTPy API, presenting your configured `OTPY_USER_KEY` as a Bearer token. The API hashes it and looks up the *live* row in the `user_keys` table — the same credential's scopes can never be spoofed or bypassed locally. If the key has been revoked or its scopes downgraded on the dashboard, the very next tool call reflects that immediately; there is no local caching of scopes.

**There is no client-side override of any kind.** Earlier versions of this server had a local `OTPY_MCP_WRITE` / `--write` flag that only ever lived in this process's own config — it was never verified against the server, so anyone with shell/env access to their own MCP client could set it and bypass write-tool gating entirely. That flag has been removed outright (not deprecated, not silently downgraded to "restrict only" — deleted). If you still have `OTPY_MCP_WRITE`/`--write` set in an old config, it is now a complete no-op: `parseConfig` doesn't read it at all, and the only thing that can grant write/billing access is a real `user_key` with the matching scope, verified over the network on every call.

If no `OTPY_USER_KEY` is configured at all, every user-key tool is denied (fails closed) — only the unscoped read tools (`get_usage`, `get_integration_snippet`) keep working with the project API key.

### Project grants

A user key can optionally be restricted to specific projects (`user_project_grants`, set on the same Integration page). The rule:

- **Zero grant rows** → unrestricted: the key can act on any project its owner can reach.
- **One or more grant rows** → restricted to exactly those project ids.

Whenever a tool call includes a `project_id` argument, the server checks this alongside the write/billing scope check (same live network call) and denies the call if the presented user key isn't granted access to that project.

## Tools

| Tool | Required scope | Description |
|---|---|---|
| `get_usage` | none | Today's usage, or usage for an inclusive date range up to 90 days |
| `list_projects` | user key | List projects visible to the user key |
| `list_otp_messages` | user key | List messages; status is internal and `verified_at` marks verification, not carrier delivery |
| `list_transactions` | `billing` | List wallet ledger transactions in tomans |
| `get_balance` | `billing` | Current wallet balance and pricing details |
| `list_api_keys` | `billing` | List project API keys and limits |
| `get_integration_snippet` | none | Generate copyable code snippets |
| `send_test_otp` | `write` | Send a test OTP code to a phone number |
| `verify_test_otp` | `write` | Verify a test OTP code |
| `create_api_key` | `write` | Create a new API key with custom limits |

Integration snippets always read `OTPY_API_KEY` from the runtime environment; the MCP server never embeds the configured raw API key in generated code.

## License

MIT © [OTPy.ir](https://otpy.ir)
