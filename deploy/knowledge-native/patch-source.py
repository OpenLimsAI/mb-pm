"""Apply the customer admission option to a copied v0.10.0 source tree, never in place."""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1]).resolve()
auth = root / "server/auth"
here = Path(__file__).resolve().parent

def replace(path, old, new):
    content = path.read_text()
    assert content.count(old) == 1, f"Unexpected source baseline: {path.name}"
    path.write_text(content.replace(old, new))

replace(auth / "config.ts", "  viewerRoles: string[];", "  /** Live Casdoor members of this organization get viewer access by default. */\n  defaultViewerOwner?: string;\n  viewerRoles: string[];")
replace(auth / "config.ts", '  const legacySessionsOwner = readOptional(env, "DIKW_WEB_AUTH_LEGACY_SESSIONS_OWNER");', '  const legacySessionsOwner = readOptional(env, "DIKW_WEB_AUTH_LEGACY_SESSIONS_OWNER");\n  const defaultViewerOwner = readOptional(env, "DIKW_WEB_DEFAULT_VIEWER_OWNER");')
replace(auth / "config.ts", '    viewerRoles,', '    ...(defaultViewerOwner ? { defaultViewerOwner } : {}),\n    viewerRoles,')
replace(auth / "gate.ts", 'import { extractRoles, requiredRole, resolveRole, type AuthRole } from "./roles.js";', 'import { requiredRole, type AuthRole } from "./roles.js";\nimport { businessRole, isActiveBusinessUser } from "./casdoorAdmission.js";')
replace(auth / "gate.ts", '  function originAllowed(req: IncomingMessage): boolean {', '''  const accountChecks = new Map<string, number>();

  async function ensureActive(
    res: ServerResponse,
    current: { id: string; session: AuthSession },
  ): Promise<boolean> {
    if (!config.defaultViewerOwner) return true;
    const last = accountChecks.get(current.id);
    if (last !== undefined && Date.now() - last < 60_000) return true;
    try {
      if (!(await isActiveBusinessUser(current.session.sub, config))) {
        sessions.delete(current.id);
        accountChecks.delete(current.id);
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
        unauthenticated(res);
        return false;
      }
    } catch {
      sendJson(res, 503, { error: { code: "iam_unavailable", message: "identity provider unavailable" } });
      return false;
    }
    for (const [id, time] of accountChecks) {
      if (Date.now() - time >= 60_000) accountChecks.delete(id);
    }
    accountChecks.set(current.id, Date.now());
    return true;
  }

  function originAllowed(req: IncomingMessage): boolean {''')
replace(auth / "gate.ts", '    const role = resolveRole(extractRoles(claims, config.rolesClaim, config.rolesOwner), config);', '''    try {
      if (!(await isActiveBusinessUser(String(claims.sub), config))) {
        res.setHeader("Set-Cookie", clearLogin);
        return sendPage(req, res, 403, "noAccess");
      }
    } catch {
      res.setHeader("Set-Cookie", clearLogin);
      return sendPage(req, res, 503, "idpUnavailable");
    }
    const role = businessRole(claims, config);''')
replace(auth / "gate.ts", '    log.info("signed in", { role: role ?? "none" });', '    if (config.defaultViewerOwner) accountChecks.set(id, Date.now());\n    log.info("signed in", { role: role ?? "none" });')
replace(auth / "gate.ts", '      sessions.delete(current.id);\n      try {', '      sessions.delete(current.id);\n      accountChecks.delete(current.id);\n      try {')
replace(auth / "gate.ts", '      if (!current) return unauthenticated(res);\n      const { sub, name, email, role }', '      if (!current) return unauthenticated(res);\n      if (!(await ensureActive(res, current))) return;\n      const { sub, name, email, role }')
replace(auth / "gate.ts", '      const { sub, name, email, role } = current.session;\n      if (!role)', '      if (!(await ensureActive(res, current))) return null;\n      const { sub, name, email, role } = current.session;\n      if (!role)')
for name in ["casdoorAdmission.ts", "casdoorAdmission.test.ts", "businessGate.test.ts"]:
    shutil.copyfile(here / name, auth / name)
print("Source patch applied to the release copy.")
