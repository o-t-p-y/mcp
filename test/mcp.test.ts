import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  handleToolCall,
  parseCliAction,
  parseConfig,
  startupNotices,
  TOOLS,
  verifyUserKeyScopes,
} from "../src/index.js";
import type { McpServerConfig } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseConfig: McpServerConfig = {
  apiKey: "test_api_key",
  userKey: "test_user_key",
  baseUrl: "https://api.otpy.ir",
};

describe("otpy mcp server", () => {
  describe("parseConfig", () => {
    it("parses apiKey/userKey/baseUrl from cli args", () => {
      const config = parseConfig(
        ["--api-key", "otpy_cli_key", "--user-key", "otpy_uk_cli_key", "--base-url", "https://custom.example"],
        {},
      );
      expect(config).toEqual({
        apiKey: "otpy_cli_key",
        userKey: "otpy_uk_cli_key",
        baseUrl: "https://custom.example",
      });
    });

    it("parses apiKey/userKey from env vars, defaulting baseUrl", () => {
      const config = parseConfig([], { OTPY_API_KEY: "otpy_env_key", OTPY_USER_KEY: "otpy_uk_env_key" });
      expect(config).toEqual({
        apiKey: "otpy_env_key",
        userKey: "otpy_uk_env_key",
        baseUrl: "https://api.otpy.ir",
      });
    });

    it("has no writeEnabled field at all -- the old client-only flag is gone, not just unused", () => {
      const config = parseConfig(["--write"], { OTPY_MCP_WRITE: "true" });
      expect(config).not.toHaveProperty("writeEnabled");
      expect(Object.keys(config).sort()).toEqual(["apiKey", "baseUrl", "userKey"]);
    });

    it("silently ignores the legacy --write flag and OTPY_MCP_WRITE env var (no-op, not an error)", () => {
      const config = parseConfig(["--api-key", "k", "--write"], { OTPY_MCP_WRITE: "1" });
      expect(config.apiKey).toBe("k");
      // No exception, no hidden field -- parseConfig simply has nothing left that reads these.
    });
  });

  describe("TOOLS", () => {
    it("lists read and write tools", () => {
      expect(TOOLS.some((t) => t.name === "get_usage")).toBe(true);
      expect(TOOLS.some((t) => t.name === "get_balance")).toBe(true);
      expect(TOOLS.some((t) => t.name === "list_projects")).toBe(true);
      expect(TOOLS.some((t) => t.name === "list_otp_messages")).toBe(true);
      expect(TOOLS.some((t) => t.name === "list_transactions")).toBe(true);
      expect(TOOLS.some((t) => t.name === "send_test_otp")).toBe(true);
    });

    it("documents internal message status and verified_at without claiming carrier receipts", () => {
      const tool = TOOLS.find((t) => t.name === "list_otp_messages")!;
      expect(tool.description).toMatch(/internal/);
      expect(tool.description).toMatch(/carrier delivery receipts/);
      expect(tool.description).toMatch(/verified_at/);
      expect(tool.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
    });

    it("no longer references the old Write Mode / dashboard-toggle mechanism in tool descriptions", () => {
      for (const tool of TOOLS) {
        expect(tool.description).not.toMatch(/Write Mode/i);
        expect(tool.description).not.toMatch(/OTPY_MCP_WRITE/);
      }
    });

    it("describes write-gated tools as requiring a real, server-verified user_key scope", () => {
      const writeTool = TOOLS.find((t) => t.name === "send_test_otp")!;
      expect(writeTool.description).toMatch(/user_key/);
      expect(writeTool.description).toMatch(/write/);
    });
  });

  describe("verifyUserKeyScopes (real, server-verified scope check)", () => {
    it("calls GET /v1/user-keys/self with the user_key as a bearer token", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
      );

      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);

      expect(result).toEqual({
        ok: true,
        scopes: { write: true, billing: false, root: false, enabled: true },
        projectAllowed: null,
      });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/user-keys/self");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
    });

    it("passes project_id as a query param and surfaces project_allowed when present", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: true, root: true, enabled: true, project_allowed: false }),
      );

      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch, "proj_123");

      expect(result).toEqual({
        ok: true,
        scopes: { write: true, billing: true, root: true, enabled: true },
        projectAllowed: false,
      });
      const [url] = mockFetch.mock.calls[0]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/user-keys/self?project_id=proj_123");
    });

    it("treats a missing userKey as all-scopes-false rather than erroring (read tools still work)", async () => {
      const mockFetch = vi.fn();
      const result = await verifyUserKeyScopes({ ...baseConfig, userKey: "" }, mockFetch as unknown as typeof fetch);

      expect(result).toEqual({
        ok: true,
        scopes: { write: false, billing: false, root: false, enabled: false },
        projectAllowed: null,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails closed (ok: false) when the API rejects the user_key with 401", async () => {
      const mockFetch = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);
      expect(result.ok).toBe(false);
    });

    it("fails closed (ok: false) on a network error", async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const result = await verifyUserKeyScopes(baseConfig, mockFetch as unknown as typeof fetch);
      expect(result.ok).toBe(false);
    });
  });

  describe("handleToolCall: real server-verified scope gating (not the old local flag)", () => {
    it("denies a write tool when the server reports write:false, even though the legacy env var claims otherwise", async () => {
      // The brief's exact scenario: an operator sets OTPY_MCP_WRITE=true locally, but the
      // real user_key on file has write:false. parseConfig no longer even has a field for
      // the legacy flag (see above), so there is nothing for it to influence here -- the
      // live scope response is the only thing that matters.
      parseConfig(["--write"], { OTPY_MCP_WRITE: "true" }); // legacy inputs: proven inert above
      const scopeFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: false, billing: false, root: false, enabled: true }),
      );

      const res = await handleToolCall("send_test_otp", { phone: "09123456789" }, baseConfig, scopeFetch as unknown as typeof fetch);

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("write");
      expect(scopeFetch).toHaveBeenCalled();
    });

    it("permits a write tool when the server reports write:true, with no legacy flag involved at all", async () => {
      const fetchFn = vi
        .fn()
        // First call: scope verification.
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
        )
        // Second call: the actual send_test_otp request.
        .mockImplementationOnce(async () => jsonResponse({ request_id: "test_req_123", free: true }));

      const res = await handleToolCall(
        "send_test_otp",
        { phone: "09123456789" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("test_req_123");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("denies a write tool outright when no userKey is configured at all", async () => {
      const scopeFetch = vi.fn();
      const res = await handleToolCall(
        "verify_test_otp",
        { phone: "09123456789", code: "123456" },
        { ...baseConfig, userKey: "" },
        scopeFetch as unknown as typeof fetch,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("user_key");
    });

    it("denies a billing tool (get_balance) when the server reports billing:false", async () => {
      const scopeFetch = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: true, billing: false, root: false, enabled: true }),
      );
      const res = await handleToolCall("get_balance", {}, baseConfig, scopeFetch as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("billing");
    });

    it("permits a billing tool (get_balance) when the server reports billing:true", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
        )
        .mockImplementationOnce(async () => jsonResponse({ balance_toman: 5000 }));

      const res = await handleToolCall(
        "get_balance",
        { project_id: "proj_1" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("balance_toman");
      const [url, init] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/balance?project_id=proj_1");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
    });

    it("rejects get_balance without project_id after the scope gate passes", async () => {
      const fetchFn = vi.fn(async () =>
        jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
      );
      const res = await handleToolCall("get_balance", {}, baseConfig, fetchFn as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("project_id is required");
    });

    it("wires list_api_keys to GET /v1/mcp-scope/projects/:projectId/api-keys", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ user_key_id: "uk1", write: false, billing: true, root: false, enabled: true }),
        )
        .mockImplementationOnce(async () => jsonResponse({ api_keys: [{ id: "ak_1", name: "default" }] }));

      const res = await handleToolCall(
        "list_api_keys",
        { project_id: "proj_1" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      const [url] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/projects/proj_1/api-keys");
      expect(res.content[0]?.text).toContain("ak_1");
    });

    it("denies write tools requiring project access when project_allowed is false for the given project_id", async () => {
      const fetchFn = vi.fn(async () =>
        jsonResponse({
          user_key_id: "uk1",
          write: true,
          billing: true,
          root: true,
          enabled: true,
          project_allowed: false,
        }),
      );

      const res = await handleToolCall(
        "create_api_key",
        { project_id: "proj_not_granted", name: "x" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("not granted access");
    });

    it("wires create_api_key to POST /v1/mcp-scope/projects/:projectId/api-keys when the gate passes", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({
            user_key_id: "uk1",
            write: true,
            billing: false,
            root: false,
            enabled: true,
            project_allowed: true,
          }),
        )
        .mockImplementationOnce(async () =>
          jsonResponse({ api_key_id: "ak_new", api_key: "otpy_secret_once", key_prefix: "otpy_secr", version: 0 }),
        );

      const res = await handleToolCall(
        "create_api_key",
        { project_id: "proj_granted", name: "x", limit_daily_otp: 100 },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      const [url, init] = fetchFn.mock.calls[1]!;
      expect(String(url)).toBe("https://api.otpy.ir/v1/mcp-scope/projects/proj_granted/api-keys");
      expect((init as RequestInit).method).toBe("POST");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test_user_key" });
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "x", limit_daily_otp: 100 });
      expect(res.content[0]?.text).toContain("ak_new");
    });

    it("executes read tools (get_usage) regardless of scopes, without calling scope verification", async () => {
      const mockFetch = vi.fn(async () =>
        jsonResponse({
          free_used_today: 1,
          free_quota_today: 10,
          paid_today: 0,
          daily_limit: 100,
        }),
      );

      const res = await handleToolCall("get_usage", {}, baseConfig, mockFetch as unknown as typeof fetch);
      expect(res.isError).toBeFalsy();
      expect(res.content[0]?.text).toContain("free_used_today");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.otpy.ir/v1/usage",
        expect.objectContaining({ headers: { authorization: "Bearer test_api_key" } }),
      );
    });

    it("passes an optional usage date range to the API", async () => {
      const mockFetch = vi.fn(async () => jsonResponse({ free_used_today: 2 }));

      const res = await handleToolCall(
        "get_usage",
        { from: "2026-09-01", to: "2026-09-07" },
        baseConfig,
        mockFetch as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
        "https://api.otpy.ir/v1/usage?from=2026-09-01&to=2026-09-07",
      );
    });

    it("marks API authorization failures as MCP tool errors", async () => {
      const usage = await handleToolCall(
        "get_usage",
        {},
        baseConfig,
        vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch,
      );
      expect(usage.isError).toBe(true);

      const projectsFetch = vi
        .fn()
        .mockImplementationOnce(async () => jsonResponse({ write: false, billing: false, enabled: true }))
        .mockImplementationOnce(async () => jsonResponse({ error: "forbidden" }, 403));
      const projects = await handleToolCall("list_projects", {}, baseConfig, projectsFetch as unknown as typeof fetch);
      expect(projects.isError).toBe(true);
    });

    it("lists projects through the user-key read surface", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () => jsonResponse({ write: false, billing: false, enabled: true }))
        .mockImplementationOnce(async () => jsonResponse({ projects: [{ id: "p1", name: "Demo" }] }));

      const res = await handleToolCall("list_projects", {}, baseConfig, fetchFn as unknown as typeof fetch);

      expect(res.isError).toBeFalsy();
      expect(String(fetchFn.mock.calls[1]?.[0])).toBe("https://api.otpy.ir/v1/mcp-scope/projects");
      expect((fetchFn.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
        authorization: "Bearer test_user_key",
      });
      expect(res.content[0]?.text).toContain("Demo");
    });

    it("lists OTP messages with a bounded limit and project grant check", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ write: false, billing: false, enabled: true, project_allowed: true }),
        )
        .mockImplementationOnce(async () =>
          jsonResponse({ messages: [{ status: "sent", verified_at: null }] }),
        );

      const res = await handleToolCall(
        "list_otp_messages",
        { project_id: "project-1", limit: 25 },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
        "https://api.otpy.ir/v1/mcp-scope/projects/project-1/otp-messages?limit=25",
      );
      expect(res.content[0]?.text).toContain("verified_at");
    });

    it("lists ledger transactions only after billing scope verification", async () => {
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(async () =>
          jsonResponse({ write: false, billing: true, enabled: true, project_allowed: true }),
        )
        .mockImplementationOnce(async () =>
          jsonResponse({ transactions: [{ amount_toman: 220, direction: -1 }] }),
        );

      const res = await handleToolCall(
        "list_transactions",
        { project_id: "project-1" },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );

      expect(res.isError).toBeFalsy();
      expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
        "https://api.otpy.ir/v1/mcp-scope/projects/project-1/ledger?limit=50",
      );
      expect((fetchFn.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
        authorization: "Bearer test_user_key",
      });
    });

    it("never embeds the raw API key in integration snippets", async () => {
      const rawKey = "otpy_super_secret_should_not_appear";
      for (const language of ["nodejs", "python", "go", "php", "curl", "csharp"]) {
        const res = await handleToolCall(
          "get_integration_snippet",
          { language },
          { ...baseConfig, apiKey: rawKey },
          vi.fn() as unknown as typeof fetch,
        );
        expect(res.content[0]?.text).not.toContain(rawKey);
        expect(res.content[0]?.text).toContain("OTPY_API_KEY");
      }
    });

    it("returns a framework-neutral PHP snippet (no Laravel assumption)", async () => {
      const res = await handleToolCall(
        "get_integration_snippet",
        { language: "php" },
        baseConfig,
        vi.fn() as unknown as typeof fetch,
      );
      const text = res.content[0]?.text ?? "";
      // The PHP snippet must run in any PHP stack: plain cURL, no framework facades.
      expect(text).toContain("curl_init");
      expect(text).not.toContain("Illuminate");
      expect(text).not.toContain("Laravel");
      expect(text).toContain("OTPY_API_KEY");
    });
  });

  describe("handleToolCall: API error flags and input validation (#43)", () => {
    const allScopes = { write: true, billing: true, root: true, enabled: true, project_allowed: true };

    function gatedFetch(apiResponse: () => Response) {
      return vi
        .fn()
        .mockImplementationOnce(async () => jsonResponse(allScopes))
        .mockImplementation(async () => apiResponse());
    }

    const toolCases: [string, Record<string, unknown>][] = [
      ["get_balance", { project_id: "proj_1" }],
      ["list_api_keys", { project_id: "proj_1" }],
      ["create_api_key", { project_id: "proj_1", name: "x" }],
      ["send_test_otp", { phone: "09123456789" }],
      ["verify_test_otp", { phone: "09123456789", code: "123456" }],
    ];

    for (const [tool, args] of toolCases) {
      it(`${tool} flags a 500 response as an MCP tool error`, async () => {
        const fetchFn = gatedFetch(() => jsonResponse({ error: "internal" }, 500));
        const res = await handleToolCall(tool, args, baseConfig, fetchFn as unknown as typeof fetch);
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("internal");
        expect(fetchFn).toHaveBeenCalledTimes(2);
      });
    }

    it("turns a non-JSON 502 body into an error with the raw text, never a SyntaxError", async () => {
      const fetchFn = gatedFetch(
        () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      );
      const res = await handleToolCall("get_balance", { project_id: "proj_1" }, baseConfig, fetchFn as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("502 Bad Gateway");
      expect(res.content[0]?.text).not.toContain("SyntaxError");
    });

    it("reports HTTP <status> when an error body is empty", async () => {
      const fetchFn = vi.fn(async () => new Response("", { status: 503 }));
      const res = await handleToolCall("get_usage", {}, baseConfig, fetchFn as unknown as typeof fetch);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toContain("HTTP 503");
      expect(res.content[0]?.text).not.toContain("SyntaxError");
    });

    for (const tool of ["list_api_keys", "create_api_key"]) {
      it(`${tool} URL-encodes project_id in the request path`, async () => {
        const fetchFn = gatedFetch(() => jsonResponse({ ok: true }));
        await handleToolCall(
          tool,
          { project_id: "a/../b?x=1#y", name: "k" },
          baseConfig,
          fetchFn as unknown as typeof fetch,
        );
        expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
          "https://api.otpy.ir/v1/mcp-scope/projects/a%2F..%2Fb%3Fx%3D1%23y/api-keys",
        );
      });
    }

    function otpCalls(fetchFn: ReturnType<typeof vi.fn>) {
      return fetchFn.mock.calls.filter(([url]) => String(url).includes("/v1/otp/"));
    }

    for (const phone of ["9123456789", "0912345678", "+989123456789", "0912345678a"]) {
      it(`verify_test_otp rejects bad phone ${JSON.stringify(phone)} without calling the API`, async () => {
        const fetchFn = gatedFetch(() => jsonResponse({ verified: true }));
        const res = await handleToolCall(
          "verify_test_otp",
          { phone, code: "123456" },
          baseConfig,
          fetchFn as unknown as typeof fetch,
        );
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("phone");
        expect(otpCalls(fetchFn)).toHaveLength(0);
      });
    }

    for (const code of ["", "12345", "1234567", "12345a", "۱۲۳۴۵۶"]) {
      it(`verify_test_otp rejects bad code ${JSON.stringify(code)} without calling the API`, async () => {
        const fetchFn = gatedFetch(() => jsonResponse({ verified: true }));
        const res = await handleToolCall(
          "verify_test_otp",
          { phone: "09123456789", code },
          baseConfig,
          fetchFn as unknown as typeof fetch,
        );
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("code");
        expect(otpCalls(fetchFn)).toHaveLength(0);
      });
    }

    it("verify_test_otp trims the code before sending it", async () => {
      const fetchFn = gatedFetch(() => jsonResponse({ verified: true }));
      const res = await handleToolCall(
        "verify_test_otp",
        { phone: "09123456789", code: " 123456 " },
        baseConfig,
        fetchFn as unknown as typeof fetch,
      );
      expect(res.isError).toBeFalsy();
      const [, init] = otpCalls(fetchFn)[0]!;
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ phone: "09123456789", code: "123456" });
    });

    for (const [tool, args] of [
      ["send_test_otp", { phone: "09123456789" }],
      ["verify_test_otp", { phone: "09123456789", code: "123456" }],
    ] as const) {
      it(`${tool} refuses to call the API when OTPY_API_KEY is empty`, async () => {
        const fetchFn = gatedFetch(() => jsonResponse({ ok: true }));
        const res = await handleToolCall(tool, { ...args }, { ...baseConfig, apiKey: "" }, fetchFn as unknown as typeof fetch);
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toContain("OTPY_API_KEY");
        expect(otpCalls(fetchFn)).toHaveLength(0);
      });
    }
  });

  describe("startupNotices", () => {
    it("warns when neither key is configured", () => {
      const notices = startupNotices({ ...baseConfig, apiKey: "", userKey: "" }, false);
      expect(notices.join("\n")).toMatch(/OTPY_API_KEY/);
      expect(notices.join("\n")).toMatch(/OTPY_USER_KEY/);
    });

    it("is silent when a key is configured and stdin is not a TTY", () => {
      expect(startupNotices(baseConfig, false)).toEqual([]);
      expect(startupNotices({ ...baseConfig, userKey: "" }, false)).toEqual([]);
      expect(startupNotices({ ...baseConfig, apiKey: "" }, false)).toEqual([]);
    });

    it("notes that the server is waiting for a client when stdin is a TTY", () => {
      const notices = startupNotices(baseConfig, true);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/waiting/i);
      expect(notices[0]).toMatch(/--help/);
    });
  });

  describe("parseCliAction", () => {
    it("detects help and version flags", () => {
      expect(parseCliAction(["--help"])).toBe("help");
      expect(parseCliAction(["-h"])).toBe("help");
      expect(parseCliAction(["--version"])).toBe("version");
      expect(parseCliAction(["-v"])).toBe("version");
      expect(parseCliAction(["--api-key", "k"])).toBeNull();
      expect(parseCliAction([])).toBeNull();
    });

    it("does not mistake a flag value for --help/--version", () => {
      expect(parseCliAction(["--api-key", "-h"])).toBeNull();
      expect(parseCliAction(["--base-url", "--version"])).toBeNull();
    });
  });

  describe("bin startup", () => {
    const distPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const pkgVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
    const noKeysEnv = (() => {
      const env = { ...process.env };
      delete env.OTPY_API_KEY;
      delete env.OTPY_USER_KEY;
      return env;
    })();

    for (const flag of ["--version", "-v"]) {
      it(`prints the version for ${flag} and exits without reading stdin`, () => {
        if (!existsSync(distPath)) return; // requires `pnpm build` first
        const result = spawnSync(process.execPath, [distPath, flag], { encoding: "utf8", timeout: 5000 });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(pkgVersion);
      });
    }

    for (const flag of ["--help", "-h"]) {
      it(`prints usage for ${flag} and exits without reading stdin`, () => {
        if (!existsSync(distPath)) return; // requires `pnpm build` first
        const result = spawnSync(process.execPath, [distPath, flag], { encoding: "utf8", timeout: 5000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Usage/);
        expect(result.stdout).toContain("--api-key");
        expect(result.stdout).toContain("--user-key");
        expect(result.stdout).toContain("--base-url");
        expect(result.stdout).toContain("--version");
      });
    }

    it("keeps stdout pure JSON-RPC and warns on stderr when no keys are configured", () => {
      if (!existsSync(distPath)) return; // requires `pnpm build` first
      const result = spawnSync(process.execPath, [distPath], {
        encoding: "utf8",
        env: noKeysEnv,
        input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/OTPY_API_KEY/);
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const msg = JSON.parse(lines[0]!) as { jsonrpc: string; id: number; result: { serverInfo: unknown } };
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toBe(1);
      expect(msg.result.serverInfo).toBeTruthy();
    });

    it("starts the server when invoked through a symlink (npm bin link)", () => {
      if (!existsSync(distPath)) return; // requires `pnpm build` first
      const dir = mkdtempSync(join(tmpdir(), "otpy-mcp-link-"));
      try {
        const link = join(dir, "otpy-mcp");
        symlinkSync(distPath, link);
        const result = spawnSync(process.execPath, [link], {
          encoding: "utf8",
          input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"serverInfo"');
        const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
        expect(result.stdout).toContain(`"version":"${pkg.version}"`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("single-sources the server version from package.json", () => {
      if (!existsSync(distPath)) return; // requires `pnpm build` first
      const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
      const result = spawnSync(process.execPath, [distPath], {
        encoding: "utf8",
        input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`"version":"${pkg.version}"`);
    });
  });
});
