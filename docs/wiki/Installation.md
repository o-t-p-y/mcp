# Installation

The OTPy MCP server runs over stdio via `npx` — no global install required.

## Prerequisites

- Node.js 18+ (for `npx`)
- An OTPy project API key (`otpy_...`) — from project settings on [dash.otpy.ir](https://dash.otpy.ir)
- Optional but recommended: a user key (`otpy_uk_...`) with the scopes you need — from the **Integrate** tab on [dash.otpy.ir](https://dash.otpy.ir). The raw secret is shown exactly once at creation.

## Cursor

Add to `.cursor/mcp.json` (or Cursor Settings → MCP):

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

## Claude Desktop

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

## Flags and environment variables

Every value can be passed as a flag or an env var; flags win.

| Flag | Env var | Default |
|---|---|---|
| `--api-key` | `OTPY_API_KEY` | — (required for OTP tools) |
| `--user-key` | `OTPY_USER_KEY` | — (required for write/billing tools) |
| `--base-url` | `OTPY_BASE_URL` | `https://api.otpy.ir` |

## Verify the install

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' | npx -y @o-t-p-y/mcp
```

Expected: a single JSON line with `serverInfo` (`name: "otpy-mcp"`, current version). The process exits on stdin EOF.

## Notes

- The legacy `OTPY_MCP_WRITE` / `--write` flag is **removed** — it was never verified server-side. It is now a complete no-op. Only a real `user_key` with the matching scope grants write/billing access. See [Scopes](Scopes).
- Without `OTPY_USER_KEY`, read-only tools (`get_usage`, `get_integration_snippet`) still work; write/billing tools fail closed with a clear message.
