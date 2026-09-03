<div dir="rtl">

# مرجع ابزارها

همه ابزارها از طریق `tools/call` در MCP فراخوانی می‌شوند. ابزارهای مشخص‌شده با **billing** یا **write** ابتدا اسکوپ‌های `OTPY_USER_KEY` را به‌صورت زنده با API تأیید می‌کنند؛ خطاها با نتیجه `isError` و پیام واضح برمی‌گردند.

## ابزارهای خواندنی (کلید API پروژه)

### `get_usage`

آمار مصرف OTP امروز.

- **ورودی:** ندارد
- **خروجی:** `{ free_used_today, free_quota_today, paid_today, daily_limit }`
- **اعتبار:** `OTPY_API_KEY`

### `get_integration_snippet`

اسنیپت ادغام آماده برای یک زبان.

- **ورودی:** `language` (الزامی) — یکی از `nodejs`، `python`، `go`، `php`، `curl`، `csharp`
- **خروجی:** متن اسنیپت کد. `nodejs` از پکیج `@o-t-p-y/sdk` استفاده می‌کند؛ بقیه زبان‌ها از HTTP خام.
- **اعتبار:** `OTPY_API_KEY`

## ابزارهای صورتحساب (کلید کاربری، اسکوپ `billing`)

### `get_balance`

موجودی فعلی کیف پول برای یک پروژه.

- **ورودی:** `project_id` (الزامی)
- **فراخوانی:** `GET /v1/mcp-scope/balance?project_id=...`
- **خروجی:** `{ balance_toman }` (تومان؛ `null` وقتی کیف پولی نیست)
- **اعتبار:** `OTPY_USER_KEY` با `billing`

### `list_api_keys`

لیست کلیدهای API یک پروژه و محدودیت‌هایشان.

- **ورودی:** `project_id` (الزامی)
- **فراخوانی:** `GET /v1/mcp-scope/projects/:projectId/api-keys`
- **خروجی:** `{ api_keys: [{ id, name, key_prefix, is_enabled, version, limit_daily_otp, limit_weekly_otp, limit_monthly_otp, limit_daily_balance_toman, limit_weekly_balance_toman, limit_monthly_balance_toman, created_at, disabled_at }] }`
- **اعتبار:** `OTPY_USER_KEY` با `billing`

## ابزارهای نوشتن (کلید کاربری، اسکوپ `write`)

### `send_test_otp`

ارسال کد OTP آزمایشی به یک شماره.

- **ورودی:** `phone` (الزامی، `09xxxxxxxxx`)
- **فراخوانی:** `POST /v1/otp/send`
- **اعتبار:** `OTPY_API_KEY` + `OTPY_USER_KEY` با `write`

### `verify_test_otp`

تایید کد OTP آزمایشی.

- **ورودی:** `phone` (الزامی)، `code` (الزامی)
- **فراخوانی:** `POST /v1/otp/verify`
- **خروجی:** `{ verified: boolean }` (فقط بولین)
- **اعتبار:** `OTPY_API_KEY` + `OTPY_USER_KEY` با `write`

### `create_api_key`

ساخت کلید API جدید برای پروژه با محدودیت‌های دلخواه.

- **ورودی:** `project_id` (الزامی)، `name` (الزامی)، `limit_daily_otp?`، `limit_weekly_otp?`، `limit_monthly_otp?`
- **فراخوانی:** `POST /v1/mcp-scope/projects/:projectId/api-keys`
- **خروجی هنگام ساخت:** `{ api_key_id, api_key, key_prefix, version }` — سکرت خام `api_key` **فقط یک بار** برگردانده می‌شود؛ فقط هش SHA-256 و پیشوند آن ذخیره می‌شود.
- **خروجی هنگام replay:** `{ api_key_id, key_prefix, version, replayed: true }` — همان درخواست تکراری فقط متادیتا برمی‌گرداند، هرگز دوباره سکرت نه.
- **اعتبار:** `OTPY_USER_KEY` با `write` (و نقش admin/dev در پروژه، اعمال‌شده در SQL)

## رفتار خطا

- نبود `project_id` در ابزاری که به آن نیاز دارد → `isError: "project_id is required."`
- `OTPY_USER_KEY` تنظیم نشده → ابزارهای write/billing با دستورالعمل راه‌اندازی رد می‌شوند.
- اسکوپ کم است (`write`/`billing` برابر false) → `isError` با نام اسکوپ کم‌مانده.
- پروژه گرنت نشده → `isError` با نام پروژه و محل گرنت کردن.

</div>
