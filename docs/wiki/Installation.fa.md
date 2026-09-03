<div dir="rtl">

# نصب

سرور MCP اُتی‌پی‌آی‌آر از طریق `npx` روی stdio اجرا می‌شود — نیازی به نصب سراسری نیست.

## پیش‌نیازها

- Node.js 18+ (برای `npx`)
- یک کلید API پروژه OTPy (`otpy_...`) — از تنظیمات پروژه در [dash.otpy.ir](https://dash.otpy.ir)
- اختیاری ولی توصیه‌شده: یک کلید کاربری (`otpy_uk_...`) با اسکوپ‌های موردنیاز — از تب **Integrate** در [dash.otpy.ir](https://dash.otpy.ir). سکرت خام فقط یک بار هنگام ساخت نمایش داده می‌شود.

## Cursor

به `.cursor/mcp.json` (یا Cursor Settings → MCP) اضافه کنید:

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

به `claude_desktop_config.json` اضافه کنید:

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

## فلگ‌ها و متغیرهای محیطی

هر مقدار را می‌توان با فلگ یا متغیر محیطی داد؛ فلگ اولویت دارد.

| فلگ | متغیر محیطی | پیش‌فرض |
|---|---|---|
| `--api-key` | `OTPY_API_KEY` | — (برای ابزارهای OTP لازم) |
| `--user-key` | `OTPY_USER_KEY` | — (برای ابزارهای write/billing لازم) |
| `--base-url` | `OTPY_BASE_URL` | `https://api.otpy.ir` |

## بررسی نصب

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' | npx -y @o-t-p-y/mcp
```

خروجی موردانتظار: یک خط JSON با `serverInfo` (‏`name: "otpy-mcp"` و نسخه فعلی). پروسه با EOF روی stdin خارج می‌شود.

## نکته‌ها

- فلگ قدیمی `OTPY_MCP_WRITE` / `--write` **حذف شده** — هرگز سمت سرور تأیید نمی‌شد. الان کاملاً بی‌اثر است. فقط یک `user_key` واقعی با اسکوپ متناظر دسترسی write/billing می‌دهد. [اسکوپ‌ها](Scopes) را ببینید.
- بدون `OTPY_USER_KEY`، ابزارهای فقط-خواندنی (`get_usage`، `get_integration_snippet`) کار می‌کنند؛ ابزارهای write/billing با پیام واضح رد می‌شوند.

</div>
