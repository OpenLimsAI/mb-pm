import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./config.js";
import { businessRole, isActiveBusinessUser } from "./casdoorAdmission.js";

const config = {
  issuer: "https://iam.example.com",
  internalUrl: "http://casdoor:8000",
  clientId: "test-client",
  clientSecret: "test-secret",
  rolesClaim: "roles[].name",
  rolesOwner: "mabpharm",
  defaultViewerOwner: "mabpharm",
  viewerRoles: ["kb_viewer"],
  editorRoles: ["kb_editor"],
} as AuthConfig;
const user = { id: "user-id", owner: "mabpharm", name: "user", isForbidden: false, isDeleted: false };
const lookup = (data: unknown) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "ok", data })));

describe("Casdoor business admission", () => {
  it("looks up the signed subject internally without exposing the application secret", async () => {
    const fetcher = lookup(user);
    expect(await isActiveBusinessUser("user-id", config, fetcher)).toBe(true);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://casdoor:8000/api/get-user?owner=mabpharm&userId=user-id");
    expect(options?.redirect).toBe("error");
    expect((options?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(String(url)).not.toContain(config.clientSecret);
  });
  it.each([
    null,
    { ...user, id: "other-id" },
    { ...user, owner: "built-in" },
    { ...user, isForbidden: true },
    { ...user, isDeleted: true },
    { ...user, isForbidden: undefined },
  ])("denies foreign, absent, disabled or malformed accounts", async (data) => {
    expect(await isActiveBusinessUser("user-id", config, lookup(data))).toBe(false);
  });
  it("fails closed on an IAM outage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(isActiveBusinessUser("user-id", config, fetcher)).rejects.toThrow(/unavailable/);
  });
  it("grants only reading by default and preserves explicit editors", () => {
    expect(businessRole({}, config)).toBe("viewer");
    expect(businessRole({ roles: [{ owner: "mabpharm", name: "kb_editor", isEnabled: true }] }, config)).toBe("editor");
    expect(businessRole({ roles: [{ owner: "built-in", name: "kb_editor" }] }, config)).toBe("viewer");
    expect(businessRole({ roles: [{ owner: "mabpharm", name: "kb_editor", isEnabled: false }] }, config)).toBe("viewer");
  });
  it("preserves strict role mapping when the organization default is unset", async () => {
    const strict = { ...config, defaultViewerOwner: undefined };
    const fetcher = lookup(null);
    expect(businessRole({}, strict)).toBeNull();
    expect(await isActiveBusinessUser("user-id", strict, fetcher)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
