<div dir="rtl">

# سرور MCP اُتی‌پی‌آی‌آر

سرور رسمی Model Context Protocol برای [OTPy.ir](https://otpy.ir) — استفاده از حساب OTPy در دستیارهای هوش مصنوعی (Cursor، Claude Desktop و هر کلاینت MCP).

## چه کار می‌کند

این سرور ابزارهای OTPy را از طریق MCP stdio در دسترس قرار می‌دهد:

- **ابزارهای خواندنی** (فقط کلید API پروژه): `get_usage`، `get_integration_snippet`
- **ابزارهای صورتحساب** (کلید کاربری با اسکوپ `billing`): `get_balance`، `list_api_keys`
- **ابزارهای نوشتن** (کلید کاربری با اسکوپ `write`): `send_test_otp`، `verify_test_otp`، `create_api_key`

همه چک‌های اسکوپ در هر فراخوانی به‌صورت زنده با API تأیید می‌شوند — هیچ دورزدن سمت کلاینتی وجود ندارد.

## صفحه‌ها

- [نصب](Installation) — راه‌اندازی Cursor و Claude Desktop
- [ابزارها](Tools) — مرجع کامل ابزارها با ورودی و خروجی
- [اسکوپ‌ها](Scopes) — مدل اسکوپ `user_keys` (‏`write`، `billing`، ‏`root` مشتق، گرنت‌های پروژه)

## نصب

```bash
npx -y @o-t-p-y/mcp
```

در کلاینت MCP خود با دو اعتبار پیکربندی کنید:

| متغیر محیطی | اعتبار | از کجا بگیرید |
|---|---|---|
| `OTPY_API_KEY` | کلید API پروژه (`otpy_...`) | تنظیمات پروژه در [dash.otpy.ir](https://dash.otpy.ir) |
| `OTPY_USER_KEY` | کلید کاربری (`otpy_uk_...`) | تب **Integrate** در [dash.otpy.ir](https://dash.otpy.ir) |

برای کانفیگ کامل کلاینت‌ها، [نصب](Installation) را ببینید.

## پیوندها

- npm: ‏[`@o-t-p-y/mcp`](https://www.npmjs.com/package/@o-t-p-y/mcp)
- مخزن: [github.com/o-t-p-y/mcp](https://github.com/o-t-p-y/mcp)
- محصول: [otpy.ir](https://otpy.ir)

</div>
