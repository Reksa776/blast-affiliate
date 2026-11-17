// AffiliateOS — permission catalog (P0.6).
//
// Source of truth: docs/08-TENANT-ISOLATION-DESIGN.md §5.1. The catalog is
// code-owned and seeded into the global `permissions` table; it is NOT created by a
// migration, so a permission can be added without DDL (and a role can be tuned
// without a deploy — the matrix lives in `role_permissions` rows).
//
// Count: 27, not 26. The P0.6 brief proposed a 26-entry list built from a different
// breakdown; the documented catalog is authoritative and the extra entry is
// `member.read` (a viewer must be able to list the team to use the product).
//
// Format is `domain.action`, lower-case, one dot. Nothing else parses permission
// strings, so the exact shape is the contract.

export const PERMISSIONS = {
  WORKSPACE_READ: "workspace.read",
  WORKSPACE_MANAGE: "workspace.manage",

  MEMBER_READ: "member.read",
  MEMBER_INVITE: "member.invite",
  MEMBER_MANAGE: "member.manage",
  ROLE_MANAGE: "role.manage",

  CREATOR_READ: "creator.read",
  CREATOR_WRITE: "creator.write",
  CREATOR_DELETE: "creator.delete",
  CREATOR_ASSIGN: "creator.assign",
  CREATOR_BLACKLIST: "creator.blacklist",
  CREATOR_EXPORT: "creator.export",

  CAMPAIGN_READ: "campaign.read",
  CAMPAIGN_WRITE: "campaign.write",
  CAMPAIGN_PUBLISH: "campaign.publish",
  CAMPAIGN_DELETE: "campaign.delete",

  SHOP_READ: "shop.read",
  SHOP_CONNECT: "shop.connect",
  SHOP_DISCONNECT: "shop.disconnect",
  SHOP_SYNC: "shop.sync",

  ANALYTICS_READ: "analytics.read",
  ANALYTICS_EXPORT: "analytics.export",

  OUTREACH_READ: "outreach.read",
  OUTREACH_SEND: "outreach.send",

  AUDIT_READ: "audit.read",

  JOB_READ: "job.read",
  JOB_RETRY: "job.retry",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Stable order used by seeds, tests and matrix reports. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  workspace: "Workspace settings",
  member: "Membership",
  role: "Roles",
  creator: "Creator CRM",
  campaign: "Campaigns",
  shop: "TikTok Shop connection",
  analytics: "Analytics",
  outreach: "Outreach",
  audit: "Audit log",
  job: "Background jobs",
};

/** Human description stored in `permissions.description` (VARCHAR(255)). */
export function permissionDescription(key: Permission): string {
  const [domain, action] = key.split(".");
  const label = DOMAIN_LABELS[domain ?? ""] ?? domain ?? "Permission";
  return `${label}: ${action ?? key}`;
}

/** Narrowing helper for values that arrive from HTTP (headers, bodies, paths). */
export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (ALL_PERMISSIONS as readonly string[]).includes(value);
}
