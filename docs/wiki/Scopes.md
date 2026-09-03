# Scopes (`user_keys`)

The OTPy MCP server gates write- and billing-sensitive tools behind a **user key** (`otpy_uk_...`) — a separate credential from the project API key. Every check is verified live against the OTPy API on every call.

## The scope model

Each user key has exactly two independently toggleable scopes, plus a derived flag:

| Scope | Grants |
|---|---|
| `write` | `send_test_otp`, `verify_test_otp`, `create_api_key` |
| `billing` | `get_balance`, `list_api_keys` |
| `root` (derived: `write AND billing`) | Everything above — shorthand only, never a separate grant |

There is no third, separately-grantable permission. `root` is always computed, never stored or set directly.

## How verification works

Every call to a `write`- or `billing`-gated tool makes a **real network request** to `GET /v1/user-keys/self`, presenting your `OTPY_USER_KEY` as a Bearer token. The API hashes it and looks up the live row in the `user_keys` table.

- Revoke the key or downgrade its scopes on the dashboard → the very next tool call reflects it.
- There is **no local caching** of scopes.
- There is **no client-side override**. The legacy `OTPY_MCP_WRITE` / `--write` flag was removed entirely — it was never verified server-side and let anyone with shell access bypass gating. It is now a no-op.

If no `OTPY_USER_KEY` is configured, every `write`/`billing`-gated tool fails closed; only the unscoped read tools (`get_usage`, `get_integration_snippet`) keep working with just the project API key.

## Project grants

A user key can optionally be restricted to specific projects (`user_project_grants`, managed on the **Integrate** tab):

- **Zero grant rows** → unrestricted: the key can act on any project its owner can reach.
- **One or more grant rows** → restricted to exactly those project IDs.

Whenever a tool call includes `project_id`, the server checks the grant alongside the scope check (same live request) and denies the call if the key isn't granted that project.

## Role enforcement (SQL)

Beyond scopes, the underlying SQL functions enforce project membership roles:

- `create_api_key` → owner must be `admin` or `dev` on the project.
- `list_api_keys` / `get_balance` → owner must be `admin`, `dev`, or `finance` (balance also allows `member`).

All authorization lives in Postgres `SECURITY DEFINER` functions — never in app code.

## Getting a user key

1. Open the **Integrate** tab on [dash.otpy.ir](https://dash.otpy.ir).
2. Create a user key with the scopes you need (`write`, `billing`, or both).
3. Copy the raw `otpy_uk_...` secret immediately — it is shown exactly once.
4. Set it as `OTPY_USER_KEY` (or `--user-key`) in your MCP client config.
