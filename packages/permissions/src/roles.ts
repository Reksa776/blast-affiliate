// AffiliateOS — workspace roles (P0.6).
//
// The six role keys are exactly the Prisma `RoleKey` enum. There is deliberately no
// `SUPER_ADMIN`: docs/08 §5.3 and the schema comment both say platform-wide access
// is a revocable `platform_admin_grants` row, not a workspace role — otherwise a
// tenant owner could mint a super user. Adding SUPER_ADMIN to the enum would need a
// migration, which P0.6 forbids; the platform path is implemented in
// `apps/web/src/lib/auth/permission.ts` instead.
//
// The matrix below is the initial default (docs/08 §5.2). It is copied into
// `role_permissions` per workspace at provisioning time, so it can be tuned per
// workspace without a deploy.

import { PERMISSIONS as P, type Permission } from "./catalog.js";

export const ROLES = {
  WORKSPACE_OWNER: "WORKSPACE_OWNER",
  WORKSPACE_ADMIN: "WORKSPACE_ADMIN",
  AFFILIATE_MANAGER: "AFFILIATE_MANAGER",
  BUSINESS_DEVELOPMENT: "BUSINESS_DEVELOPMENT",
  ANALYST: "ANALYST",
  VIEWER: "VIEWER",
} as const;

export type WorkspaceRole = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly WorkspaceRole[] = Object.values(ROLES);

export const ROLE_LABELS: Readonly<Record<WorkspaceRole, string>> = {
  WORKSPACE_OWNER: "Workspace Owner",
  WORKSPACE_ADMIN: "Workspace Admin",
  AFFILIATE_MANAGER: "Affiliate Manager",
  BUSINESS_DEVELOPMENT: "Business Development",
  ANALYST: "Analyst",
  VIEWER: "Viewer",
};

const OWNER_PERMISSIONS: readonly Permission[] = [
  P.WORKSPACE_READ,
  P.WORKSPACE_MANAGE,
  P.MEMBER_READ,
  P.MEMBER_INVITE,
  P.MEMBER_MANAGE,
  P.ROLE_MANAGE,
  P.CREATOR_READ,
  P.CREATOR_WRITE,
  P.CREATOR_DELETE,
  P.CREATOR_ASSIGN,
  P.CREATOR_BLACKLIST,
  P.CREATOR_EXPORT,
  P.CAMPAIGN_READ,
  P.CAMPAIGN_WRITE,
  P.CAMPAIGN_PUBLISH,
  P.CAMPAIGN_DELETE,
  P.SHOP_READ,
  P.SHOP_CONNECT,
  P.SHOP_DISCONNECT,
  P.SHOP_SYNC,
  P.ANALYTICS_READ,
  P.ANALYTICS_EXPORT,
  P.OUTREACH_READ,
  P.OUTREACH_SEND,
  P.AUDIT_READ,
  P.JOB_READ,
  P.JOB_RETRY,
];

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly Permission[]>> = {
  // Everything, including workspace destruction-adjacent management.
  WORKSPACE_OWNER: OWNER_PERMISSIONS,

  // Everything except `workspace.manage` (only the owner may rename/delete the
  // workspace itself).
  WORKSPACE_ADMIN: OWNER_PERMISSIONS.filter((permission) => permission !== P.WORKSPACE_MANAGE),

  AFFILIATE_MANAGER: [
    P.WORKSPACE_READ,
    P.MEMBER_READ,
    P.CREATOR_READ,
    P.CREATOR_WRITE,
    P.CREATOR_DELETE,
    P.CREATOR_ASSIGN,
    P.CREATOR_BLACKLIST,
    P.CREATOR_EXPORT,
    P.CAMPAIGN_READ,
    P.CAMPAIGN_WRITE,
    P.CAMPAIGN_PUBLISH,
    P.CAMPAIGN_DELETE,
    P.SHOP_READ,
    P.ANALYTICS_READ,
    P.ANALYTICS_EXPORT,
    P.OUTREACH_READ,
    P.OUTREACH_SEND,
  ],

  BUSINESS_DEVELOPMENT: [
    P.WORKSPACE_READ,
    P.MEMBER_READ,
    P.CREATOR_READ,
    P.CREATOR_WRITE,
    P.CREATOR_ASSIGN,
    P.CAMPAIGN_READ,
    P.SHOP_READ,
    P.ANALYTICS_READ,
  ],

  ANALYST: [
    P.WORKSPACE_READ,
    P.MEMBER_READ,
    P.CREATOR_READ,
    P.CREATOR_EXPORT,
    P.CAMPAIGN_READ,
    P.SHOP_READ,
    P.ANALYTICS_READ,
    P.ANALYTICS_EXPORT,
    P.AUDIT_READ,
  ],

  VIEWER: [
    P.WORKSPACE_READ,
    P.MEMBER_READ,
    P.CREATOR_READ,
    P.CAMPAIGN_READ,
    P.SHOP_READ,
    P.ANALYTICS_READ,
  ],
};

/** True when this role holds the permission in the default matrix. */
export function roleHasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
