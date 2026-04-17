# Team Settings Audit Log — Scope + Server-Side Filtering

## Problem

The team settings Audit Log section has two gaps:

1. **Scope leakage.** `GET /team/audit-log` returns
   `AuditLog.find({ teamId })` with no action filtering. Admin-originated and
   platform-level audit entries (`superadmin:granted`, `superadmin:revoked`,
   `notification_log.retention_updated`, data retention task events) can show
   up under a team's audit log and confuse operators. The admin router at
   `packages/api/src/routers/api/admin.ts:217` also writes with
   `teamId: actor._id` (a User id, not a Team id) — a pre-existing bug that
   compounds the leakage but is out of scope for this change.
2. **No filters.** The client (`AuditLogSection.tsx`) only supports
   pagination. The sibling Notification Log has a full filter bar (channel,
   status, recipient, trigger, date range, search) and expandable detail
   rows. Audit Log should match.

## Goals

- Restrict `GET /team/audit-log` to actions that originate from team
  settings — using the existing `noun:verb` naming convention as a
  whitelist.
- Add server-side filters parallel in shape to the Notification Log
  endpoint.
- Rewrite `AuditLogSection.tsx` to match the Notification Log UX: filter
  bar + expandable detail rows.

## Non-goals

- Do **not** change `GET /admin/audit-log`. Super admins still see
  everything.
- Do **not** fix the `teamId: actor._id` bug in `admin.ts:217` in this
  change. The whitelist filter hides it from the team view; a separate
  follow-up can correct the write.
- Do **not** migrate the existing `AuditLog` schema. No new fields are
  added; a single new compound index is the only schema-side change.

## Design

### 1. Whitelist (server-authoritative)

Add to `packages/api/src/routers/api/team.ts`:

```ts
export const TEAM_SETTINGS_ACTION_PREFIXES = [
  'member', 'role', 'permission', 'group',
  'webhook', 'apikey', 'connection', 'source',
  'policy', 'integration', 'telegram',
] as const;

export const TEAM_SETTINGS_ACTION_REGEX = new RegExp(
  `^(${TEAM_SETTINGS_ACTION_PREFIXES.join('|')}):`,
);
```

Applied to every team audit-log query — list, count, and the distinct
endpoint. Any existing or future admin/platform action (`superadmin:*`,
`notification_log.*`, retention task events) is excluded unless its
prefix is added to this list.

### 2. `GET /team/audit-log` — expanded filters

Filters are AND-combined with `{ teamId, action: { $regex:
TEAM_SETTINGS_ACTION_REGEX } }`.

| Query param | Behavior | Validation |
|---|---|---|
| `actorEmail` | case-insensitive regex | string, max 200, escaped |
| `action` | exact match **revalidated against whitelist** — reject (or return empty) if the supplied action does not match the whitelist regex | string, max 100 |
| `targetType` | exact match | enum of known types |
| `targetId` | exact match | string, max 100 |
| `fromDate` / `toDate` | `createdAt` range | ISO date |
| `search` | regex across `actorEmail`, `action`, `targetType` (NOT `details` — Mixed field, regex-on-JSON is impractical and expensive) | string, max 200, escaped |

All regex inputs escape Mongo/ReDoS special characters before being
passed to `$regex`. Validation is via Zod, matching the pattern used by
other team routes.

Response shape matches the Notification Log endpoint:
`{ data, totalCount, page, limit }`.

### 3. `GET /team/audit-log/actions` — new

Returns `{ data: string[] }` — the distinct `action` values for the
team, pre-filtered by the whitelist. Uses the existing
`{ teamId: 1, action: 1 }` index. Feeds the action dropdown in the UI;
cached via TanStack Query.

### 4. Client

**`packages/app/src/api.ts`**
- Expand `useTeamAuditLog(page, limit, filters?)` to accept
  `{ actorEmail?, action?, targetType?, targetId?, fromDate?, toDate?,
  search? }`. Mirror the URL-building pattern from
  `useTeamNotificationLog`.
- Add `useTeamAuditLogActions()` — caches the distinct-actions list.

**`packages/app/src/components/TeamSettings/AuditLogSection.tsx`** —
rewrite to parallel `NotificationLogSection.tsx`:

- Filter bar (`Group` with `wrap="wrap"`):
  - Action — `Select`, options from `useTeamAuditLogActions`, clearable
  - Target type — `Select`, static enum: user, role, group, webhook,
    apikey, connection, source, policy, integration, telegram
  - Actor email — `TextInput`
  - Target ID — `TextInput`
  - Search — `TextInput` with `IconSearch`
  - From date / To date — `DatePickerInput`
  - Reset button (resets filters and `page` to 0)
- Table with chevron column + expandable row. Expanded row shows:
  - Pretty-printed `details` (Code block)
  - `targetId`, `actorId`, `_id`
- Pagination unchanged.

### 5. Indexes

Existing indexes cover most paths:

- `{ teamId: 1, createdAt: -1 }` — default sort ✓
- `{ teamId: 1, action: 1 }` — action filter + distinct ✓

Add one:

```ts
AuditLogSchema.index({ teamId: 1, targetType: 1, createdAt: -1 });
```

`targetType` has low cardinality (~10 values), so a compound index is
worthwhile. Other filters (actor regex, targetId exact, date range)
operate within the `teamId` prefix and have low enough volume that
in-memory narrowing is fine.

### 6. Tests

**API (integration, `packages/api/src/routers/api/__tests__/team.ts`):**

- Whitelist excludes `superadmin:*` and
  `notification_log.retention_updated` even when those entries share the
  same `teamId`.
- Each filter param (`actorEmail`, `action`, `targetType`, `targetId`,
  `fromDate`/`toDate`, `search`) narrows results correctly.
- A client-supplied `action` outside the whitelist returns empty (does
  not bypass).
- Regex inputs containing special characters are escaped (input
  `role:.*` is treated as literal, not a pattern).
- `/audit-log/actions` returns only whitelisted actions present for the
  team.

**Client:** follow the prevailing test pattern for `TeamSettings`
components (if one exists) — otherwise rely on manual QA + the
end-to-end Playwright suite.

## Risks & open items

- **Whitelist maintenance.** New team-settings features that introduce
  a new action prefix must update `TEAM_SETTINGS_ACTION_PREFIXES`.
  Mitigation: prefix is one constant, co-located with the route, and
  mentioned in `AGENTS.md` as part of the audit-log contract. A
  missing prefix is visually obvious (new actions don't appear in the
  dropdown or table).
- **`teamId: actor._id` bug in `admin.ts:217`** — pre-existing, not
  fixed here. The whitelist neutralizes its impact on the team view.
  Flagged for a follow-up.
- **Search over `details`** — deliberately excluded. If we later want
  full-text search across JSON details, consider a dedicated text index
  or pre-indexed denormalized field.

## Rollout

Single PR. No feature flag, no migration. The index can be added in
the same PR; Mongo creates it in the background on startup.

## Follow-ups (not in this change)

1. Fix `admin.ts:217` so `teamId` holds a real team id.
2. Consider whether admin global audit log should also gain the
   expanded filter set (parity with the team view).
