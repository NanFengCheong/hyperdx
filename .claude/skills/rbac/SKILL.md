---
name: rbac
description: Maintain RBAC permissions — audit, add, rename, or remove permissions; keep PERMISSIONS constants, routes, and system roles in sync. Use when asked to "add permission", "check RBAC", "audit permissions", "update roles", "permission drift", or "requirePermission".
---

# RBAC Permission Maintenance

Audit and maintain the HyperDX RBAC system. Ensure permission constants, route guards, system roles, and frontend usage are always in sync.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `packages/common-utils/src/permissions.ts` | `PERMISSIONS` constants, `ALL_PERMISSIONS`, `PERMISSION_CATEGORIES`, `SYSTEM_ROLES`, `hasPermission()`, `resolvePermissions()` |
| `packages/api/src/middleware/auth.ts` | `requirePermission()`, `requireWriteAccess()`, `getResolvedPermissions()`, `getUserDataScope()`, `requireSuperAdmin()` |
| `packages/api/src/routers/api/*.ts` | Route-level `requirePermission('...')` middleware calls |
| `packages/api/src/api-app.ts` | `requireWriteAccess` mounted on write-capable route groups |
| `packages/api/src/routers/external-api/v2/index.ts` | `requireWriteAccess` on external API routes |
| `packages/app/src/contexts/PermissionContext.tsx` | Frontend permission context provider |
| `packages/app/src/hooks/usePermission.ts` | `usePermission()` and `useIsSuperAdmin()` hooks |
| `packages/app/src/components/RequirePermission.tsx` | Guard component for conditional rendering |

### Data Models

| Model | Location | Key Fields |
|-------|----------|------------|
| `Role` | `packages/api/src/models/role.ts` | `name`, `teamId` (null for system), `permissions[]`, `dataScopes[]`, `isSystem` |
| `User` | `packages/api/src/models/user.ts` | `roleId`, `groupId` (legacy), `permissionOverrides.{grants,revokes}`, `isSuperAdmin` |
| `Group` | `packages/api/src/models/group.ts` | `name`, `teamId`, `accountAccess` (`read-only`|`read-write`), `dataScope` (legacy) |

### System Roles (defined in `SYSTEM_ROLES`)

| Role | Permissions | Purpose |
|------|-------------|---------|
| `SUPER_ADMIN` | `platform:admin` | Global platform admin |
| `ADMIN` | All except `platform:admin` | Team admin |
| `EDITOR` | All `*:view`, `*:create`, `*:edit`, plus `explorer:query`, `alerts:silence`, `apikeys:rotate`, `integrations:manage` | Can create/edit content |
| `VIEWER` | All `*:view` plus `explorer:query` | Read-only access |

### Permission Resolution

```
effective = Set(rolePermissions + userGrants)
for each revoke in userRevokes: effective.delete(revoke)
return Array.from(effective)
```

`hasPermission()` checks: exact match → `*:*` wildcard → `resource:*` wildcard.

### Access Control Layers

1. **`requireWriteAccess`** — blocks POST/PUT/PATCH/DELETE for users in legacy `read-only` groups. Mounted globally on write-capable routes in `api-app.ts`.
2. **`requirePermission('resource:action')`** — fine-grained per-route check. Resolves role + user overrides.
3. **Data scope filtering** — row-level access control via SQL injection (ClickHouse proxy) and WHERE clause appending (charts).

## Workflow

When asked to maintain RBAC permissions, follow these steps:

### 1. Audit Current State

Run these searches to build a complete picture:

```
# All defined permissions in PERMISSIONS constant
grep: "PERMISSIONS\." in packages/common-utils/src/permissions.ts

# All permissions actually used in route guards
grep: "requirePermission\('[^']+'\)" in packages/api/src/

# All permission categories
grep: "PERMISSION_CATEGORIES" in packages/common-utils/src/permissions.ts

# System role definitions
grep: "SYSTEM_ROLES" in packages/common-utils/src/permissions.ts
```

### 2. Check for Drift

Compare these sets:

**Defined but unused**: Permissions in `PERMISSIONS` that no route calls via `requirePermission()`. These are dead code unless used in `SYSTEM_ROLES` or frontend-only checks.

**Used but undefined**: `requirePermission('X')` calls where `'X'` is not in `PERMISSIONS` — this is a **bug** that will always return 403.

**Missing from SYSTEM_ROLES**: When adding a new permission, decide which system roles should include it. For example:
- `resource:view` → add to VIEWER, EDITOR, ADMIN
- `resource:create` → add to EDITOR, ADMIN
- `resource:delete` → add to ADMIN only
- `resource:manage` (special admin) → add to ADMIN only

### 3. Make Changes

#### Adding a New Permission

1. **Add to `PERMISSIONS`** in `packages/common-utils/src/permissions.ts`:
   ```typescript
   RESOURCE_FOO: 'resource:foo',
   ```

2. **Add to `PERMISSION_CATEGORIES`** in the appropriate category group (or create a new category).

3. **Update `SYSTEM_ROLES`** — add to the appropriate role permission arrays:
   - VIEWER gets `*:view` permissions
   - EDITOR gets `*:view`, `*:create`, `*:edit` plus specific special permissions
   - ADMIN gets all except `platform:admin`

4. **Add `requirePermission()` guards** to the relevant routes in `packages/api/src/routers/api/`.

5. **Add frontend guards** using `<RequirePermission>` or `usePermission()` where needed.

#### Renaming a Permission

1. Update the key and value in `PERMISSIONS`.
2. Update all `PERMISSION_CATEGORIES` references.
3. Update all `SYSTEM_ROLES` references.
4. Update all `requirePermission()` calls in route files.
5. Update all frontend `usePermission()` / `<RequirePermission>` usages.
6. **Note**: This is a breaking change for any stored role permissions in the database. Consider a migration script if production roles reference the old name.

#### Removing a Permission

1. Remove from `PERMISSIONS`.
2. Remove from `PERMISSION_CATEGORIES`.
3. Remove from `SYSTEM_ROLES`.
4. Remove or update all `requirePermission()` calls (either remove the guard or replace with a different permission).
5. Remove frontend usage.

### 4. Verify

After making changes, run these checks:

```bash
# Check TypeScript compilation
make ci-lint

# Run unit tests
make ci-unit
```

Then self-verify:

1. **No undefined permissions**: Every string passed to `requirePermission('...')` must exist in `PERMISSIONS` values or be a valid wildcard (`resource:*`, `*:*`).
2. **No orphaned permissions**: Every permission in `PERMISSIONS` should either be used in a route guard, referenced in a system role, or used in frontend-only checks.
3. **System roles are consistent**: If a new `*:view` permission exists, VIEWER should include it. If `*:create` exists, EDITOR should include it.
4. **Categories are complete**: Each category in `PERMISSION_CATEGORIES` should list all permissions for that resource.

### 5. Common Pitfalls

- **Never use a permission string that isn't in `PERMISSIONS`** — it will compile but always 403 at runtime.
- **`requireWriteAccess` is legacy** — it only checks `groupId.accountAccess`, not `roleId`. Migrated users bypass it. Fine-grained `requirePermission()` is the correct mechanism.
- **Wildcards work**: `resource:*` grants all `resource:action` permissions. `*:*` grants everything.
- **Super admin bypass**: `isSuperAdmin: true` skips all permission checks.
- **Data scopes are separate**: `dataScopes[]` on Role controls row-level visibility, not action permissions.
- **Permission overrides are per-user**: `User.permissionOverrides.{grants,revokes}` add/remove from role permissions for individual users.
- **System roles have `teamId: null`**: They are shared across all teams. Custom roles have a specific `teamId`.
- **System roles cannot be modified**: The API returns 400 if you try to PATCH/DELETE a role where `isSystem === true`.

## Quick Reference

### Permissions by Resource

| Resource | view | create | edit | delete | special |
|----------|------|--------|------|--------|---------|
| dashboards | ✓ | ✓ | ✓ | ✓ | — |
| alerts | ✓ | ✓ | ✓ | ✗ | `alerts:silence` |
| searches | ✓ | ✓ | ✓ | ✓ | — |
| explorer | ✓ | — | — | — | `explorer:query` |
| sessions | ✓ | — | — | — | — |
| servicemap | ✓ | — | — | — | — |
| sources | ✓ | ✓ | ✓ | ✓ | — |
| connections | ✓ | ✓ | ✓ | ✓ | — |
| apikeys | ✓ | ✓ | — | ✓ | `apikeys:rotate` |
| webhooks | ✓ | ✓ | ✓ | ✓ | — |
| members | ✓ | — | — | — | `members:invite`, `members:remove`, `members:assign-group` |
| roles | ✓ | ✓ | ✓ | ✓ | — |
| security | ✓ | — | — | — | `security:edit` |
| querysettings | ✓ | — | — | — | `querysettings:edit` |
| integrations | ✓ | — | — | — | `integrations:manage` |
| platform | — | — | — | — | `platform:admin` |

### Role Permission Summary

| Permission | SUPER_ADMIN | ADMIN | EDITOR | VIEWER |
|------------|:-----------:|:-----:|:------:|:------:|
| `platform:admin` | ✓ | — | — | — |
| All `*:view` | ✓ | ✓ | ✓ | ✓ |
| All `*:create` | ✓ | ✓ | ✓ | — |
| All `*:edit` | ✓ | ✓ | ✓ | — |
| All `*:delete` | ✓ | ✓ | — | — |
| `explorer:query` | ✓ | ✓ | ✓ | ✓ |
| `alerts:silence` | ✓ | ✓ | ✓ | — |
| `apikeys:rotate` | ✓ | ✓ | ✓ | — |
| `integrations:manage` | ✓ | ✓ | ✓ | — |
| `members:remove` | ✓ | ✓ | — | — |
| `members:assign-group` | ✓ | ✓ | — | — |
| `members:invite` | ✓ | ✓ | — | — |
| `roles:*` | ✓ | ✓ | — | — |
| `security:edit` | ✓ | ✓ | — | — |
| `querysettings:edit` | ✓ | ✓ | — | — |
