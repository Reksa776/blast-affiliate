// AffiliateOS — @affiliateos/permissions
//
// One import site for the catalog and the role matrix. Consumed by the database
// seed (`seedPermissionCatalog`, `createDefaultRolesForWorkspace`) and by the web
// app's `requirePermission`.

export {
  ALL_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  permissionDescription,
  type Permission,
} from "./catalog.js";

export {
  ALL_ROLES,
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  roleHasPermission,
  type WorkspaceRole,
} from "./roles.js";
