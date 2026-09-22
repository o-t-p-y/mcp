# Tools Reference

All tools are called over MCP `tools/call`. Tools marked **billing** or **write** first verify the configured `OTPY_USER_KEY` scopes live against the OTPy API; failures return an `isError` result with a clear message.

## Read tools (project API key)

### `get_usage`

OTP usage statistics for today, or for an optional inclusive date range of up to 90 days.

- **Input:** `from?`, `to?` (`YYYY-MM-DD`; pass both for a range)
- **Output:** `{ free_used_today, free_quota_today, paid_today, daily_limit }`
- **Auth:** `OTPY_API_KEY`

### `list_projects`

List projects visible to the configured user key.

- **Input:** none
- **Output:** `{ projects: [{ id, name, created_at }] }`
- **Auth:** enabled `OTPY_USER_KEY`

### `list_otp_messages`

List recent OTP messages for a project. Message `status` is internal processing state and does not represent carrier delivery receipts; `verified_at` marks user verification.

- **Input:** `project_id` (required), `limit?` (1–100, default 50)
- **Output:** `{ messages: [{ phone, status, attempts, is_free, expires_at, created_at, resolved_at, verified_at, provider_ref }] }`
- **Auth:** enabled `OTPY_USER_KEY`; no write/billing scope required

### `list_transactions`

List recent wallet ledger transactions for a project. Amounts are in tomans.

- **Input:** `project_id` (required), `limit?` (1–100, default 50)
- **Output:** `{ transactions: [{ direction, amount_toman, is_free, source, balance_after_toman, created_at }] }`
- **Auth:** `OTPY_USER_KEY` with `billing`

### `get_integration_snippet`

Ready-to-use integration snippet for a language.

- **Input:** `language` (required) — one of `nodejs`, `python`, `go`, `php`, `curl`, `csharp`
- **Output:** code snippet text. `nodejs` uses the `@o-t-p-y/sdk` package; all other languages use raw HTTP. Every language reads `OTPY_API_KEY` from its runtime environment; the configured raw key is never embedded.
- **Auth:** `OTPY_API_KEY`

## Billing tools (user key, `billing` scope)

### `get_balance`

Current wallet balance for a project.

- **Input:** `project_id` (required)
- **Calls:** `GET /v1/mcp-scope/balance?project_id=...`
- **Output:** `{ balance_toman }` (Tomans; `null` when no wallet row)
- **Auth:** `OTPY_USER_KEY` with `billing`

### `list_api_keys`

List a project's API keys and their limits.

- **Input:** `project_id` (required)
- **Calls:** `GET /v1/mcp-scope/projects/:projectId/api-keys`
- **Output:** `{ api_keys: [{ id, name, key_prefix, is_enabled, version, limit_daily_otp, limit_weekly_otp, limit_monthly_otp, limit_daily_balance_toman, limit_weekly_balance_toman, limit_monthly_balance_toman, created_at, disabled_at }] }`
- **Auth:** `OTPY_USER_KEY` with `billing`

## Write tools (user key, `write` scope)

### `send_test_otp`

Send a test OTP to a phone number.

- **Input:** `phone` (required, `09xxxxxxxxx`)
- **Calls:** `POST /v1/otp/send`
- **Auth:** `OTPY_API_KEY` + `OTPY_USER_KEY` with `write`

### `verify_test_otp`

Verify a test OTP code.

- **Input:** `phone` (required), `code` (required)
- **Calls:** `POST /v1/otp/verify`
- **Output:** `{ verified: boolean }` (boolean-only verdict)
- **Auth:** `OTPY_API_KEY` + `OTPY_USER_KEY` with `write`

### `create_api_key`

Create a new project API key with optional limits.

- **Input:** `project_id` (required), `name` (required), `limit_daily_otp?`, `limit_weekly_otp?`, `limit_monthly_otp?`
- **Calls:** `POST /v1/mcp-scope/projects/:projectId/api-keys`
- **Output on create:** `{ api_key_id, api_key, key_prefix, version }` — the raw `api_key` secret is returned **exactly once**; only its SHA-256 hash and prefix are stored.
- **Output on replay:** `{ api_key_id, key_prefix, version, replayed: true }` — same idempotent request returns metadata only, never the secret again.
- **Auth:** `OTPY_USER_KEY` with `write` (and project role admin/dev, enforced in SQL)

## Error behavior

- Missing `project_id` on a tool that requires it → `isError: "project_id is required."`
- No `OTPY_USER_KEY` configured → write/billing tools fail closed with setup instructions.
- Scope missing (`write`/`billing` false) → `isError` naming the missing scope.
- Project not granted → `isError` naming the project and where to grant it.
