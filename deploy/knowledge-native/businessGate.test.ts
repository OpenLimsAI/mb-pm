import { createServer, request, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "./config.js";
import { createAuthGate } from "./gate.js";
import type { OidcClient } from "./oidc.js";
import type { AuthSession, AuthSessionStore } from "./sessionStore.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(claimRoles: unknown[] = []) {
  const config: AuthConfig = {
    publicUrl: "https://kb.example.com",
    issuer: "https://iam.example.com",
    internalUrl: "http://casdoor:8000",
    clientId: "fake-client",
    clientSecret: "fake-client-secret",
    scopes: "openid profile email",
    rolesClaim: "roles[].name",
    rolesOwner: "mabpharm",
    defaultViewerOwner: "mabpharm",
    viewerRoles: ["kb_viewer"],
    editorRoles: ["kb_editor"],
    sessionSecret: "a".repeat(64),
    sessionTtlSeconds: 3600,
    coreUrl: "http://core:8765",
    serverToken: "fake-core-secret",
  };
  let offset = 0;
  const originalNow = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => originalNow() + offset);
  let user = { id: "business-sub", owner: "mabpharm", name: "user", isForbidden: false, isDeleted: false };
  let unavailable = false;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== config.internalUrl) return originalFetch(input, init);
    expect(url.pathname).toBe("/api/get-user");
    expect(url.searchParams.get("owner")).toBe("mabpharm");
    expect(url.searchParams.get("userId")).toBe("business-sub");
    if (unavailable) return new Response("", { status: 503 });
    return new Response(JSON.stringify({ status: "ok", data: user }));
  });
  const oidc: OidcClient = {
    beginLogin: async (returnTo) => ({
      url: "https://iam.example.com/authorize",
      tx: { state: "fake-state", nonce: "fake-nonce", codeVerifier: "v".repeat(43), returnTo },
    }),
    completeLogin: async () => ({ claims: { sub: "business-sub", roles: claimRoles }, idToken: "fake-id-token" }),
    logoutUrl: async () => null,
  };
  const rows = new Map<string, AuthSession>();
  const store = {
    create(value: AuthSession) { const id = randomUUID(); rows.set(id, value); return id; },
    get(id: string) { return rows.get(id) ?? null; },
    delete(id: string) { rows.delete(id); },
  } as unknown as AuthSessionStore;
  const gate = createAuthGate({ config, oidc, sessions: store });
  const server = createServer(async (req, res) => {
    const principal = await gate.authorize(req, res);
    if (principal) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(principal)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test server address");
  const port = address.port;
  function send(path: string, headers: Record<string, string> = {}, method = "GET") {
    return new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += String(chunk); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, cookies: res.headers["set-cookie"] ?? [] }));
      });
      req.on("error", reject); req.end();
    });
  }
  async function signIn() {
    const login = await send("/web/auth/login?returnTo=%2F%23mb-web");
    expect(login.status).toBe(302);
    const transaction = login.cookies.find((cookie) => cookie.startsWith("dikw_login="))!.split(";")[0]!;
    const callback = await send("/web/auth/callback?code=fake-code&state=fake-state", { cookie: transaction });
    const session = callback.cookies.find((cookie) => cookie.startsWith("dikw_session="))?.split(";")[0];
    return { callback, cookie: session ?? "" };
  }
  return { send, signIn, advance: () => { offset += 61_000; }, forbid: () => { user = { ...user, isForbidden: true }; }, foreign: () => { user = { ...user, owner: "built-in" }; }, outage: () => { unavailable = true; } };
}

describe("business admission through the HTTP auth gate", () => {
  it("lets an active business user without roles read and denies editor operations", async () => {
    const { signIn, send } = await setup();
    const { callback, cookie } = await signIn();
    expect(callback.status).toBe(302);
    const me = await send("/web/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body).role).toBe("viewer");
    expect((await send("/v1/base/pages", { cookie })).status).toBe(200);
    expect((await send("/v1/base/pages", { cookie, origin: "https://kb.example.com" }, "POST")).status).toBe(403);
    expect(me.body).not.toContain("fake-client-secret");
    expect(me.body).not.toContain("fake-core-secret");
  });
  it("preserves explicitly assigned editors", async () => {
    const { signIn, send } = await setup([{ owner: "mabpharm", name: "kb_editor", isEnabled: true }]);
    const { cookie } = await signIn();
    expect((await send("/v1/base/pages", { cookie, origin: "https://kb.example.com" }, "POST")).status).toBe(200);
  });
  it("revokes an existing session when IAM disables its owner", async () => {
    const { signIn, send, forbid, advance } = await setup();
    const { cookie } = await signIn();
    forbid();
    expect((await send("/v1/base/pages", { cookie })).status).toBe(200);
    advance();
    const me = await send("/web/auth/me", { cookie });
    expect(me.status).toBe(401);
    expect(me.cookies.some((value) => value.startsWith("dikw_session=;") && value.includes("Max-Age=0"))).toBe(true);
    expect((await send("/v1/base/pages", { cookie })).status).toBe(401);
  });
  it("fails closed on IAM outage after the identity cache expires", async () => {
    const { signIn, send, outage, advance } = await setup();
    const { cookie } = await signIn();
    outage(); advance();
    expect((await send("/v1/base/pages", { cookie })).status).toBe(503);
    expect((await send("/web/auth/me", { cookie })).status).toBe(503);
  });
  it("does not issue a session to a user from another organization", async () => {
    const { signIn, foreign } = await setup();
    foreign();
    const { callback, cookie } = await signIn();
    expect(callback.status).toBe(403);
    expect(cookie).toBe("");
  });
});
