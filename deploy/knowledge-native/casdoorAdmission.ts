import type { AuthConfig } from "./config.js";
import { extractRoles, resolveRole, type AuthRole } from "./roles.js";

/** The optional organization default grants reading, while editors remain explicit. */
export async function isActiveBusinessUser(
  sub: string,
  config: AuthConfig,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.defaultViewerOwner) return true;
  const url = new URL("/api/get-user", config.internalUrl ?? config.issuer);
  url.searchParams.set("owner", config.defaultViewerOwner);
  url.searchParams.set("userId", sub);
  const response = await fetcher(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("IAM account lookup unavailable");
  const result = (await response.json()) as {
    status?: string;
    data?: {
      id?: string;
      owner?: string;
      name?: string;
      isForbidden?: boolean;
      isDeleted?: boolean;
    };
  };
  if (result.status !== "ok") throw new Error("IAM account lookup unavailable");
  const user = result.data;
  return !!(
    user &&
    user.id === sub &&
    user.owner === config.defaultViewerOwner &&
    user.name &&
    user.isForbidden === false &&
    user.isDeleted === false
  );
}

/** Called only after OIDC has verified the ID token and after the live account check. */
export function businessRole(claims: Record<string, unknown>, config: AuthConfig): AuthRole | null {
  const mapped = resolveRole(extractRoles(claims, config.rolesClaim, config.rolesOwner), config);
  return mapped ?? (config.defaultViewerOwner ? "viewer" : null);
}
