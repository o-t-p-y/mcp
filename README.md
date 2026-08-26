# @otpy/mcp

Official Model Context Protocol (MCP) server for [OTPy.ir](https://otpy.ir) — interact with your OTPy account, inspect usage, send test codes, and manage keys directly from AI assistants.

## Installation / Setup

### Cursor

Add to your `.cursor/mcp.json` or Cursor Settings → MCP:

```json
{
  "mcpServers": {
    "otpy": {
      "command": "npx",
      "args": ["-y", "@otpy/mcp"],
      "env": {
        "OTPY_API_KEY": "otpy_your_key_here",
        "OTPY_MCP_WRITE": "false"
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
      "args": ["-y", "@otpy/mcp"],
      "env": {
        "OTPY_API_KEY": "otpy_your_key_here",
        "OTPY_MCP_WRITE": "false"
      }
    }
  }
}
```

## Write Mode Configuration

- **Read-Only Mode (Default)**: `OTPY_MCP_WRITE=false`
  - Allows checking quota usage, balances, project details, and code snippets.
  - Rejects any mutation (sending live test OTPs or generating keys).
- **Write Mode**: `OTPY_MCP_WRITE=true` (or passing `--write` flag)
  - Enables `send_test_otp`, `verify_test_otp`, `create_api_key`, and `toggle_api_key`.

You can also copy the pre-configured MCP snippet directly from the **تنظیمات پروژه** tab on [dash.otpy.ir](https://dash.otpy.ir).

## Tools

| Tool | Mode | Description |
|---|---|---|
| `get_usage` | Read | Daily quota and free/paid usage breakdown |
| `get_balance` | Read | Current wallet balance and pricing details |
| `list_api_keys` | Read | List project API keys and limits |
| `get_integration_snippet` | Read | Generate copyable code snippets |
| `send_test_otp` | **Write** | Send a test OTP code to a phone number |
| `verify_test_otp` | **Write** | Verify a test OTP code |
| `create_api_key` | **Write** | Create a new API key with custom limits |

## License

MIT © [OTPy.ir](https://otpy.ir)
