# OTPy MCP Server

Official Model Context Protocol server for [OTPy.ir](https://otpy.ir) — use your OTPy account from AI assistants (Cursor, Claude Desktop, and any MCP client).

## What it does

The server exposes OTPy tools over MCP stdio:

- **Read tools** (project API key only): `get_usage`, `get_integration_snippet`
- **Billing tools** (user key with `billing` scope): `get_balance`, `list_api_keys`
- **Write tools** (user key with `write` scope): `send_test_otp`, `verify_test_otp`, `create_api_key`

All scope checks are verified live against the OTPy API on every call — there is no client-side override.

## Pages

- [Installation](Installation) — Cursor and Claude Desktop setup
- [Tools](Tools) — full tool reference with inputs and outputs
- [Scopes](Scopes) — the `user_keys` scope model (`write`, `billing`, derived `root`, project grants)

## Install

```bash
npx -y @o-t-p-y/mcp
```

Configure it in your MCP client with two credentials:

| Env var | Credential | Where to get it |
|---|---|---|
| `OTPY_API_KEY` | Project API key (`otpy_...`) | Project settings on [dash.otpy.ir](https://dash.otpy.ir) |
| `OTPY_USER_KEY` | User key (`otpy_uk_...`) | **Integrate** tab on [dash.otpy.ir](https://dash.otpy.ir) |

See [Installation](Installation) for complete client configs.

## Links

- npm: [`@o-t-p-y/mcp`](https://www.npmjs.com/package/@o-t-p-y/mcp)
- Repository: [github.com/o-t-p-y/mcp](https://github.com/o-t-p-y/mcp)
- Product: [otpy.ir](https://otpy.ir)
