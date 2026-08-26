import { describe, expect, it, vi } from "vitest";
import { handleToolCall, parseConfig, TOOLS } from "../src/index.js";

describe("otpy mcp server", () => {
  it("parses config from cli args and env vars", () => {
    const config = parseConfig(["--api-key", "otpy_cli_key", "--write"], {});
    expect(config.apiKey).toBe("otpy_cli_key");
    expect(config.writeEnabled).toBe(true);

    const envConfig = parseConfig([], { OTPY_API_KEY: "otpy_env_key", OTPY_MCP_WRITE: "false" });
    expect(envConfig.apiKey).toBe("otpy_env_key");
    expect(envConfig.writeEnabled).toBe(false);
  });

  it("lists read and write tools", () => {
    expect(TOOLS.some((t) => t.name === "get_usage")).toBe(true);
    expect(TOOLS.some((t) => t.name === "get_balance")).toBe(true);
    expect(TOOLS.some((t) => t.name === "send_test_otp")).toBe(true);
  });

  it("blocks write tools when write mode is disabled", async () => {
    const config = { apiKey: "test_key", baseUrl: "https://api.otpy.ir", writeEnabled: false };
    const res = await handleToolCall("send_test_otp", { phone: "09123456789" }, config);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("Write mode is disabled");
  });

  it("permits write tools when write mode is enabled", async () => {
    const config = { apiKey: "test_key", baseUrl: "https://api.otpy.ir", writeEnabled: true };
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: "test_req_123", free: true }), { status: 200 }),
    );

    const res = await handleToolCall("send_test_otp", { phone: "09123456789" }, config, mockFetch as any);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("test_req_123");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("executes read tools regardless of write mode", async () => {
    const config = { apiKey: "test_key", baseUrl: "https://api.otpy.ir", writeEnabled: false };
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          free_used_today: 1,
          free_quota_today: 10,
          paid_today: 0,
          daily_limit: 100,
        }),
        { status: 200 },
      ),
    );

    const res = await handleToolCall("get_usage", {}, config, mockFetch as any);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("free_used_today");
  });
});
