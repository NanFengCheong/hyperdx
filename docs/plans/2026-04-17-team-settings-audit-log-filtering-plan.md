# Team Settings Audit Log — Scope + Filters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restrict `GET /team/audit-log` to team-settings actions only (action-prefix whitelist), add parity server-side filters with the notification log (actor/action/targetType/targetId/dates/search), add an action-distinct endpoint, and rewrite `AuditLogSection.tsx` to match `NotificationLogSection.tsx` (filter bar + expandable rows).

**Architecture:** A single source-of-truth whitelist constant drives both list filtering and the distinct-actions dropdown. Zod validation on query params via `validateRequest` (the existing pattern). Regex inputs are escaped to prevent ReDoS-via-user-input. No schema migration — one new compound index only.

**Tech Stack:** Express + Mongoose on the API; Zod + `zod-express-middleware` for validation; Mantine + TanStack Query on the client.

**Design doc:** `docs/plans/2026-04-17-team-settings-audit-log-filtering-design.md`

---

## Conventions to know before starting

- Test harness: `packages/api/src/routers/api/__tests__/team.test.ts` uses `getServer` and `getLoggedInAgent` from `@/fixtures`. Read one existing test block there (e.g. the members section) before writing new ones to copy the exact login flow, URL style (`/api/v1/team/...`), and MongoDB cleanup between tests.
- `validateRequest` is imported from `zod-express-middleware`; Zod is already imported in `team.ts` at the top.
- `requirePermission('roles:view')` is already used for the existing audit-log route — reuse it.
- Client API helper pattern: see `useTeamNotificationLog` in `packages/app/src/api.ts` (around line 586) — mirror its `URLSearchParams` build.
- Client component pattern: `packages/app/src/components/TeamSettings/NotificationLogSection.tsx` is the template — mirror filter bar, expandable row, reset button, pagination section.
- Pre-commit hook: runs lint-staged. If hook isn't set up in a worktree, run `npx lint-staged` manually before commit. **Never** use `--no-verify`.
- **After finishing all code edits**, run `yarn lint:fix` per the repo's `AGENTS.md`.

---

## Task 1: Add compound index on `(teamId, targetType, createdAt)`

**Files:**
- Modify: `packages/api/src/models/auditLog.ts`

**Step 1: Write the failing test**

Append to `packages/api/src/routers/api/__tests__/team.test.ts` (inside a new `describe('GET /team/audit-log', () => { ... })` block; put it at the end of the file):

```ts
import AuditLog from '@/models/auditLog';

describe('AuditLog indexes', () => {
  it('has a (teamId, targetType, createdAt) compound index', async () => {
    const indexes = await AuditLog.collection.indexes();
    const found = indexes.find(
      i =>
        JSON.stringify(i.key) ===
        JSON.stringify({ teamId: 1, targetType: 1, createdAt: -1 }),
    );
    expect(found).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx
make dev-int FILE=team
```

Expected: FAIL — "expected object to be defined".

**Step 3: Add the index**

In `packages/api/src/models/auditLog.ts`, after the existing `AuditLogSchema.index({ actorEmail: 1, createdAt: -1 })`:

```ts
// Team-scoped targetType filtering + sort (GET /team/audit-log?targetType=)
AuditLogSchema.index({ teamId: 1, targetType: 1, createdAt: -1 });
```

**Step 4: Run test to verify it passes**

```bash
make dev-int FILE=team
```

Expected: PASS on the new index test.

**Step 5: Commit**

```bash
git add packages/api/src/models/auditLog.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): add (teamId, targetType, createdAt) index on AuditLog"
```

---

## Task 2: Export the team-settings action whitelist

**Files:**
- Create: `packages/api/src/models/auditLogWhitelist.ts`

**Rationale:** Put the whitelist in a dedicated file so the team router, tests, and future code can import it without circular deps.

**Step 1: Write the failing test**

Append to `packages/api/src/routers/api/__tests__/team.test.ts`:

```ts
describe('TEAM_SETTINGS_ACTION_REGEX', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    TEAM_SETTINGS_ACTION_REGEX,
  } = require('@/models/auditLogWhitelist');

  it.each([
    'member:removed',
    'member:reactivated',
    'role:created',
    'role:updated',
    'role:deleted',
    'permission:overrides-updated',
    'group:created',
    'webhook:created',
    'apikey:rotated',
    'connection:updated',
    'source:deleted',
    'policy:updated',
    'integration:connected',
    'telegram:linked',
  ])('accepts team-settings action "%s"', action => {
    expect(TEAM_SETTINGS_ACTION_REGEX.test(action)).toBe(true);
  });

  it.each([
    'superadmin:granted',
    'superadmin:revoked',
    'notification_log.retention_updated',
    'data_retention.purged',
    'clickhouse_retention.updated',
    '',
    'unknown:action',
  ])('rejects non-team-settings action "%s"', action => {
    expect(TEAM_SETTINGS_ACTION_REGEX.test(action)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
make dev-int FILE=team
```

Expected: FAIL — `Cannot find module '@/models/auditLogWhitelist'`.

**Step 3: Create the whitelist module**

`packages/api/src/models/auditLogWhitelist.ts`:

```ts
export const TEAM_SETTINGS_ACTION_PREFIXES = [
  'member',
  'role',
  'permission',
  'group',
  'webhook',
  'apikey',
  'connection',
  'source',
  'policy',
  'integration',
  'telegram',
] as const;

export const TEAM_SETTINGS_ACTION_REGEX = new RegExp(
  `^(${TEAM_SETTINGS_ACTION_PREFIXES.join('|')}):`,
);

export const TEAM_SETTINGS_TARGET_TYPES = [
  'user',
  'role',
  'group',
  'webhook',
  'apikey',
  'connection',
  'source',
  'policy',
  'integration',
  'telegram',
] as const;

export type TeamSettingsTargetType =
  (typeof TEAM_SETTINGS_TARGET_TYPES)[number];
```

**Step 4: Run test to verify it passes**

```bash
make dev-int FILE=team
```

Expected: PASS on all whitelist regex cases.

**Step 5: Commit**

```bash
git add packages/api/src/models/auditLogWhitelist.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): add team-settings audit action whitelist"
```

---

## Task 3: Restrict `GET /team/audit-log` to whitelisted actions

**Files:**
- Modify: `packages/api/src/routers/api/team.ts` (the existing `/audit-log` handler near line 1006)

**Step 1: Write the failing test**

Append to the `describe('GET /team/audit-log', ...)` block:

```ts
import AuditLog from '@/models/auditLog';

// ... existing whitelist describe block above ...

describe('GET /team/audit-log — whitelist', () => {
  it('excludes non-team-settings actions (superadmin:*, notification_log.*)', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);

    await AuditLog.create([
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: user.email,
        action: 'member:removed',
        targetType: 'user',
        targetId: 'u1',
        details: {},
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: user.email,
        action: 'superadmin:granted',
        targetType: 'user',
        targetId: 'u2',
        details: {},
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: user.email,
        action: 'notification_log.retention_updated',
        targetType: 'PlatformSetting',
        targetId: 'x',
        details: {},
      },
    ]);

    const res = await agent.get('/api/v1/team/audit-log').expect(200);
    const actions = res.body.data.map((d: any) => d.action).sort();
    expect(actions).toEqual(['member:removed']);
    expect(res.body.totalCount).toBe(1);

    await server.stop();
  });
});
```

(If `getLoggedInAgent` signature differs in this repo, match the one used by the existing tests in the same file — the shape above matches typical HyperDX fixtures.)

**Step 2: Run test to verify it fails**

```bash
make dev-int FILE=team
```

Expected: FAIL — returns 3 entries instead of 1, whitelist not applied.

**Step 3: Apply the whitelist in the handler**

In `packages/api/src/routers/api/team.ts`, update the `/audit-log` handler:

```ts
import {
  TEAM_SETTINGS_ACTION_REGEX,
} from '@/models/auditLogWhitelist';

// ... inside the router.get('/audit-log', ...) handler, replace the filter:

const filter: Record<string, any> = {
  teamId,
  action: { $regex: TEAM_SETTINGS_ACTION_REGEX },
};

const [data, totalCount] = await Promise.all([
  AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit),
  AuditLog.countDocuments(filter),
]);

res.json({ data, totalCount, page, limit });
```

**Step 4: Run test to verify it passes**

```bash
make dev-int FILE=team
```

Expected: PASS. Only `member:removed` is returned.

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/team.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): restrict GET /team/audit-log to whitelisted actions"
```

---

## Task 4: Add `actorEmail`, `targetType`, `targetId`, date range filters

**Files:**
- Modify: `packages/api/src/routers/api/team.ts`

**Rationale:** These are "simple" filters — no regex bypass concerns beyond escaping. Land them together to save churn.

**Step 1: Write the failing tests**

Append to the audit-log describe block:

```ts
describe('GET /team/audit-log — filters', () => {
  const setup = async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);

    const baseDate = new Date('2026-04-15T10:00:00Z');
    await AuditLog.create([
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'alice@example.com',
        action: 'role:created',
        targetType: 'role',
        targetId: 'r1',
        details: { name: 'admin' },
        createdAt: baseDate,
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'bob@example.com',
        action: 'member:removed',
        targetType: 'user',
        targetId: 'u1',
        details: {},
        createdAt: new Date('2026-04-16T10:00:00Z'),
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'alice@example.com',
        action: 'role:deleted',
        targetType: 'role',
        targetId: 'r2',
        details: { name: 'viewer' },
        createdAt: new Date('2026-04-17T10:00:00Z'),
      },
    ]);
    return { server, agent };
  };

  it('filters by actorEmail (case-insensitive regex)', async () => {
    const { server, agent } = await setup();
    const res = await agent
      .get('/api/v1/team/audit-log?actorEmail=ALICE')
      .expect(200);
    expect(res.body.totalCount).toBe(2);
    expect(
      res.body.data.every((d: any) => d.actorEmail === 'alice@example.com'),
    ).toBe(true);
    await server.stop();
  });

  it('filters by targetType (exact)', async () => {
    const { server, agent } = await setup();
    const res = await agent
      .get('/api/v1/team/audit-log?targetType=role')
      .expect(200);
    expect(res.body.totalCount).toBe(2);
    await server.stop();
  });

  it('filters by targetId (exact)', async () => {
    const { server, agent } = await setup();
    const res = await agent
      .get('/api/v1/team/audit-log?targetId=r1')
      .expect(200);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.data[0].action).toBe('role:created');
    await server.stop();
  });

  it('filters by fromDate/toDate (inclusive)', async () => {
    const { server, agent } = await setup();
    const res = await agent
      .get(
        '/api/v1/team/audit-log?fromDate=2026-04-16T00:00:00Z&toDate=2026-04-16T23:59:59Z',
      )
      .expect(200);
    expect(res.body.totalCount).toBe(1);
    expect(res.body.data[0].action).toBe('member:removed');
    await server.stop();
  });

  it('escapes regex special chars in actorEmail', async () => {
    const { server, agent } = await setup();
    // '.*' should be treated literally, not as a pattern
    const res = await agent
      .get('/api/v1/team/audit-log?actorEmail=.*')
      .expect(200);
    expect(res.body.totalCount).toBe(0);
    await server.stop();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
make dev-int FILE=team
```

Expected: FAIL on all — filters not yet implemented; `actorEmail=.*` would match all entries today.

**Step 3: Implement filters with Zod validation + regex escaping**

Add a helper near the top of `team.ts` (below the existing imports):

```ts
import { TEAM_SETTINGS_ACTION_REGEX } from '@/models/auditLogWhitelist';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Replace the `/audit-log` handler body:

```ts
const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  actorEmail: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  search: z.string().max(200).optional(),
});

router.get(
  '/audit-log',
  requirePermission('roles:view'),
  validateRequest({ query: auditLogQuerySchema }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const page = req.query.page ? Number(req.query.page) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : 50;

      const filter: Record<string, any> = {
        teamId,
        action: { $regex: TEAM_SETTINGS_ACTION_REGEX },
      };

      if (req.query.actorEmail) {
        filter.actorEmail = {
          $regex: escapeRegex(String(req.query.actorEmail)),
          $options: 'i',
        };
      }
      if (req.query.targetType) {
        filter.targetType = String(req.query.targetType);
      }
      if (req.query.targetId) {
        filter.targetId = String(req.query.targetId);
      }
      if (req.query.fromDate || req.query.toDate) {
        filter.createdAt = {};
        if (req.query.fromDate) {
          filter.createdAt.$gte = new Date(String(req.query.fromDate));
        }
        if (req.query.toDate) {
          filter.createdAt.$lte = new Date(String(req.query.toDate));
        }
      }

      const [data, totalCount] = await Promise.all([
        AuditLog.find(filter)
          .sort({ createdAt: -1 })
          .skip(page * limit)
          .limit(limit),
        AuditLog.countDocuments(filter),
      ]);

      res.json({ data, totalCount, page, limit });
    } catch (e) {
      next(e);
    }
  },
);
```

**Step 4: Run tests to verify they pass**

```bash
make dev-int FILE=team
```

Expected: PASS on all filter tests.

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/team.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): add actorEmail/targetType/targetId/date filters to team audit log"
```

---

## Task 5: Add `action` filter with whitelist revalidation + `search`

**Files:**
- Modify: `packages/api/src/routers/api/team.ts`

**Rationale:** `action` and `search` are the trickier cases — `action` must revalidate against the whitelist (never trust client), and `search` spans multiple fields via `$or` (must compose cleanly with the whitelist `action` clause).

**Step 1: Write the failing tests**

Append:

```ts
describe('GET /team/audit-log — action + search', () => {
  it('filters by exact action when whitelisted', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);
    await AuditLog.create([
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'a@x',
        action: 'role:created',
        targetType: 'role',
        targetId: 'r1',
        details: {},
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'a@x',
        action: 'role:deleted',
        targetType: 'role',
        targetId: 'r1',
        details: {},
      },
    ]);
    const res = await agent
      .get('/api/v1/team/audit-log?action=role:created')
      .expect(200);
    expect(res.body.totalCount).toBe(1);
    await server.stop();
  });

  it('returns empty when action is not whitelisted (no bypass)', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);
    await AuditLog.create({
      teamId: team._id,
      actorId: user._id,
      actorEmail: 'a@x',
      action: 'superadmin:granted',
      targetType: 'user',
      targetId: 'u1',
      details: {},
    });
    const res = await agent
      .get('/api/v1/team/audit-log?action=superadmin:granted')
      .expect(200);
    expect(res.body.totalCount).toBe(0);
    await server.stop();
  });

  it('search matches across actorEmail, action, targetType', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);
    await AuditLog.create([
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'alice@example.com',
        action: 'role:created',
        targetType: 'role',
        targetId: 'r1',
        details: {},
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'bob@example.com',
        action: 'webhook:created',
        targetType: 'webhook',
        targetId: 'w1',
        details: {},
      },
    ]);
    const hitsRole = await agent
      .get('/api/v1/team/audit-log?search=role')
      .expect(200);
    expect(hitsRole.body.totalCount).toBe(1);

    const hitsAlice = await agent
      .get('/api/v1/team/audit-log?search=alice')
      .expect(200);
    expect(hitsAlice.body.totalCount).toBe(1);

    await server.stop();
  });

  it('search + action-filter both apply (whitelist preserved)', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);
    await AuditLog.create([
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'a@x',
        action: 'role:created',
        targetType: 'role',
        targetId: 'r1',
        details: {},
      },
      {
        teamId: team._id,
        actorId: user._id,
        actorEmail: 'a@x',
        action: 'superadmin:granted',
        targetType: 'user',
        targetId: 'u1',
        details: {},
      },
    ]);
    const res = await agent
      .get('/api/v1/team/audit-log?search=granted')
      .expect(200);
    expect(res.body.totalCount).toBe(0); // whitelist filters out the granted
    await server.stop();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
make dev-int FILE=team
```

Expected: FAIL — `action` and `search` not handled.

**Step 3: Implement `action` and `search`**

In the `/audit-log` handler, add AFTER the whitelist `filter.action` assignment:

```ts
if (req.query.action) {
  const requested = String(req.query.action);
  if (!TEAM_SETTINGS_ACTION_REGEX.test(requested)) {
    // Silently return empty — do not leak whether the non-whitelisted
    // action exists. Preserving the regex in filter.action would still
    // match nothing, but setting an impossible match is explicit.
    filter.action = requested;
    filter._noMatch = true;
  } else {
    filter.action = requested;
  }
}

if (req.query.search) {
  const escaped = escapeRegex(String(req.query.search));
  const re = { $regex: escaped, $options: 'i' };
  filter.$and = (filter.$and ?? []).concat([
    {
      $or: [
        { actorEmail: re },
        { action: re },
        { targetType: re },
      ],
    },
  ]);
}
```

Wait — the `filter._noMatch = true` trick is ugly. Replace with the idiomatic approach: short-circuit return when the action is not whitelisted.

Replace that block with:

```ts
if (req.query.action) {
  const requested = String(req.query.action);
  if (!TEAM_SETTINGS_ACTION_REGEX.test(requested)) {
    return res.json({ data: [], totalCount: 0, page, limit });
  }
  filter.action = requested;
}
```

And for `search`, because `filter.action` is already set (either the regex or an exact value), the `$and` wrapper keeps both clauses alive:

```ts
if (req.query.search) {
  const escaped = escapeRegex(String(req.query.search));
  const re = { $regex: escaped, $options: 'i' };
  filter.$and = [
    {
      $or: [
        { actorEmail: re },
        { action: re },
        { targetType: re },
      ],
    },
  ];
}
```

Note: when `search` also provides an `action` regex (via `$or`), Mongo will AND the whitelist `filter.action` regex with the `$or.action` regex — both must match. That's correct: search still respects the whitelist.

**Step 4: Run tests to verify they pass**

```bash
make dev-int FILE=team
```

Expected: PASS on all four new tests.

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/team.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): add action + search filters to team audit log (whitelist-preserving)"
```

---

## Task 6: Add `GET /team/audit-log/actions` endpoint

**Files:**
- Modify: `packages/api/src/routers/api/team.ts`

**Step 1: Write the failing test**

Append:

```ts
describe('GET /team/audit-log/actions', () => {
  it('returns only whitelisted distinct actions for the team', async () => {
    const server = getServer();
    await server.start();
    const { agent, team, user } = await getLoggedInAgent(server);
    await AuditLog.create([
      { teamId: team._id, actorId: user._id, actorEmail: 'a@x', action: 'role:created', targetType: 'role', targetId: 'r1', details: {} },
      { teamId: team._id, actorId: user._id, actorEmail: 'a@x', action: 'role:created', targetType: 'role', targetId: 'r2', details: {} },
      { teamId: team._id, actorId: user._id, actorEmail: 'a@x', action: 'member:removed', targetType: 'user', targetId: 'u1', details: {} },
      { teamId: team._id, actorId: user._id, actorEmail: 'a@x', action: 'superadmin:granted', targetType: 'user', targetId: 'u2', details: {} },
    ]);
    const res = await agent.get('/api/v1/team/audit-log/actions').expect(200);
    expect(res.body.data.sort()).toEqual(['member:removed', 'role:created']);
    await server.stop();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
make dev-int FILE=team
```

Expected: FAIL — 404 (route does not exist).

**Step 3: Add the route**

In `team.ts`, directly after the `/audit-log` handler:

```ts
router.get(
  '/audit-log/actions',
  requirePermission('roles:view'),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const actions = await AuditLog.distinct('action', {
        teamId,
        action: { $regex: TEAM_SETTINGS_ACTION_REGEX },
      });
      res.json({ data: actions.sort() });
    } catch (e) {
      next(e);
    }
  },
);
```

**Step 4: Run test to verify it passes**

```bash
make dev-int FILE=team
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/team.ts \
        packages/api/src/routers/api/__tests__/team.test.ts
git commit -m "feat(api): add GET /team/audit-log/actions distinct endpoint"
```

---

## Task 7: Expand `useTeamAuditLog` and add `useTeamAuditLogActions`

**Files:**
- Modify: `packages/app/src/api.ts` (around line 576)

**Rationale:** No tests for the api.ts hooks exist in this repo; the React/Mantine component will exercise them. Keep this task focused and commit on its own.

**Step 1: Replace the existing `useTeamAuditLog` and add `useTeamAuditLogActions`**

Locate the block at roughly line 576 and replace:

```ts
useTeamAuditLog(
  page = 0,
  limit = 50,
  filters?: {
    actorEmail?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
  },
) {
  return useQuery({
    queryKey: ['team/audit-log', page, limit, filters],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (filters?.actorEmail) params.set('actorEmail', filters.actorEmail);
      if (filters?.action) params.set('action', filters.action);
      if (filters?.targetType) params.set('targetType', filters.targetType);
      if (filters?.targetId) params.set('targetId', filters.targetId);
      if (filters?.fromDate) params.set('fromDate', filters.fromDate);
      if (filters?.toDate) params.set('toDate', filters.toDate);
      if (filters?.search) params.set('search', filters.search);
      return hdxServer(`team/audit-log?${params}`).json<{
        data: any[];
        totalCount: number;
        page: number;
        limit: number;
      }>();
    },
  });
},
useTeamAuditLogActions() {
  return useQuery({
    queryKey: ['team/audit-log/actions'],
    queryFn: () =>
      hdxServer('team/audit-log/actions').json<{ data: string[] }>(),
    staleTime: 60_000, // 1 minute cache
  });
},
```

**Step 2: Type-check**

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx
make ci-lint
```

Expected: PASS (TypeScript compiles without errors). Fix any import/type issues surfaced.

**Step 3: Commit**

```bash
git add packages/app/src/api.ts
git commit -m "feat(app): expand useTeamAuditLog with filters, add useTeamAuditLogActions"
```

---

## Task 8: Rewrite `AuditLogSection.tsx` to mirror `NotificationLogSection.tsx`

**Files:**
- Modify: `packages/app/src/components/TeamSettings/AuditLogSection.tsx` (full rewrite)

**Step 1: Replace the file contents**

```tsx
import { Fragment, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Code,
  Collapse,
  Divider,
  Group,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconSearch,
} from '@tabler/icons-react';

import api from '@/api';

const PAGE_SIZE = 50;

const TARGET_TYPE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'role', label: 'Role' },
  { value: 'group', label: 'Group' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'apikey', label: 'API Key' },
  { value: 'connection', label: 'Connection' },
  { value: 'source', label: 'Source' },
  { value: 'policy', label: 'Policy' },
  { value: 'integration', label: 'Integration' },
  { value: 'telegram', label: 'Telegram' },
];

export default function AuditLogSection() {
  const [page, setPage] = useState(0);
  const [actorEmail, setActorEmail] = useState('');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = {
    actorEmail: actorEmail || undefined,
    action: action || undefined,
    targetType: targetType || undefined,
    targetId: targetId || undefined,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    search: search || undefined,
  };

  const { data: auditLog, isLoading } = api.useTeamAuditLog(
    page,
    PAGE_SIZE,
    filters,
  );
  const { data: actionsData } = api.useTeamAuditLogActions();

  const actionOptions = [
    ...(actionsData?.data?.map(a => ({ value: a, label: a })) ?? []),
  ];

  const totalCount = auditLog?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '\u2014';
    return new Date(dateStr).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const resetFilters = () => {
    setActorEmail('');
    setAction('');
    setTargetType('');
    setTargetId('');
    setSearch('');
    setFromDate(null);
    setToDate(null);
    setPage(0);
  };

  return (
    <Box id="audit-log" data-testid="audit-log-section">
      <Text size="md">Audit Log</Text>
      <Divider my="md" />

      <Group mb="md" gap="sm" wrap="wrap">
        <Select
          size="xs"
          placeholder="Action"
          data={actionOptions}
          value={action}
          onChange={v => {
            setAction(v ?? '');
            setPage(0);
          }}
          clearable
          searchable
          w={200}
        />
        <Select
          size="xs"
          placeholder="Target type"
          data={TARGET_TYPE_OPTIONS}
          value={targetType}
          onChange={v => {
            setTargetType(v ?? '');
            setPage(0);
          }}
          clearable
          w={160}
        />
        <TextInput
          size="xs"
          placeholder="Actor email"
          value={actorEmail}
          onChange={e => {
            setActorEmail(e.currentTarget.value);
            setPage(0);
          }}
          w={200}
        />
        <TextInput
          size="xs"
          placeholder="Target ID"
          value={targetId}
          onChange={e => {
            setTargetId(e.currentTarget.value);
            setPage(0);
          }}
          w={180}
        />
        <TextInput
          size="xs"
          placeholder="Search actor/action/target"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={e => {
            setSearch(e.currentTarget.value);
            setPage(0);
          }}
          w={240}
        />
        <DatePickerInput
          size="xs"
          placeholder="From date"
          value={fromDate}
          onChange={v => {
            setFromDate(v);
            setPage(0);
          }}
          clearable
          w={150}
        />
        <DatePickerInput
          size="xs"
          placeholder="To date"
          value={toDate}
          onChange={v => {
            setToDate(v);
            setPage(0);
          }}
          clearable
          w={150}
        />
        <Button size="compact-xs" variant="subtle" onClick={resetFilters}>
          Reset
        </Button>
      </Group>

      <Card>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={30} />
                <Table.Th>Date</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Target ID</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoading &&
                Array.isArray(auditLog?.data) &&
                auditLog.data.map((entry: any) => (
                  <Fragment key={entry._id}>
                    <Table.Tr
                      onClick={() =>
                        setExpandedId(
                          expandedId === entry._id ? null : entry._id,
                        )
                      }
                      style={{ cursor: 'pointer' }}
                    >
                      <Table.Td>
                        {expandedId === entry._id ? (
                          <IconChevronUp size={14} />
                        ) : (
                          <IconChevronDown size={14} />
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{formatDate(entry.createdAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{entry.actorEmail ?? '\u2014'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" fw={500}>
                          {entry.action ?? '\u2014'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{entry.targetType ?? '\u2014'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate maw={220}>
                          {entry.targetId ?? '\u2014'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                    {expandedId === entry._id && (
                      <Table.Tr key={`${entry._id}-detail`}>
                        <Table.Td colSpan={6}>
                          <Collapse in={expandedId === entry._id}>
                            <Box p="sm">
                              <Text size="xs" fw={600} mb={4}>
                                Details:
                              </Text>
                              <Code block>
                                {JSON.stringify(entry.details ?? {}, null, 2)}
                              </Code>
                              <Text size="xs" c="dimmed" mt="xs">
                                Entry ID: {entry._id}
                              </Text>
                              {entry.actorId && (
                                <Text size="xs" c="dimmed">
                                  Actor ID: {entry.actorId}
                                </Text>
                              )}
                            </Box>
                          </Collapse>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                ))}
              {!isLoading &&
                (!auditLog?.data || auditLog.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No audit log entries found.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
            </Table.Tbody>
          </Table>
        </Card.Section>
        {totalCount > PAGE_SIZE && (
          <Card.Section withBorder py="sm" px="lg">
            <Group justify="space-between" align="center">
              <Text size="xs" c="dimmed">
                Page {page + 1} of {totalPages} ({totalCount} entries)
              </Text>
              <Group gap="xs">
                <Button
                  size="compact-sm"
                  variant="secondary"
                  leftSection={<IconChevronLeft size={14} />}
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="compact-sm"
                  variant="secondary"
                  rightSection={<IconChevronRight size={14} />}
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                </Button>
              </Group>
            </Group>
          </Card.Section>
        )}
      </Card>
    </Box>
  );
}
```

**Step 2: Type-check**

```bash
make ci-lint
```

Expected: PASS.

**Step 3: Manual smoke test**

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx
yarn dev
```

- Open the dev portal (http://localhost:9900) and click through to the local app.
- Navigate to Team Settings → Audit Log section.
- Verify:
  - Filter bar renders: Action (Select, populated from `/team/audit-log/actions`), Target type, Actor email, Target ID, Search, From/To dates, Reset.
  - Pick an action → list narrows.
  - Type an email fragment → list narrows, case-insensitive.
  - Click a row → expands with pretty-printed `details`.
  - Reset → all filters clear, page resets to 0.
  - Admin-originated entries (if any, e.g. `superadmin:granted`) do NOT appear.

Stop with Ctrl-C when done.

**Step 4: Commit**

```bash
git add packages/app/src/components/TeamSettings/AuditLogSection.tsx
git commit -m "feat(app): AuditLogSection filter bar + expandable rows (parity with NotificationLog)"
```

---

## Task 9: Final lint + verification

**Step 1: Auto-fix formatting across all packages**

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx
yarn lint:fix
```

**Step 2: Full CI-grade checks**

```bash
make ci-lint
make ci-unit
```

Expected: PASS on both.

**Step 3: If lint:fix changed files, commit**

```bash
git status
# if there are changes:
git add -u
git commit -m "chore: apply lint:fix after audit-log changes"
```

---

## Summary of commits

1. `feat(api): add (teamId, targetType, createdAt) index on AuditLog`
2. `feat(api): add team-settings audit action whitelist`
3. `feat(api): restrict GET /team/audit-log to whitelisted actions`
4. `feat(api): add actorEmail/targetType/targetId/date filters to team audit log`
5. `feat(api): add action + search filters to team audit log (whitelist-preserving)`
6. `feat(api): add GET /team/audit-log/actions distinct endpoint`
7. `feat(app): expand useTeamAuditLog with filters, add useTeamAuditLogActions`
8. `feat(app): AuditLogSection filter bar + expandable rows (parity with NotificationLog)`
9. `chore: apply lint:fix after audit-log changes` *(only if lint:fix made changes)*

## Follow-ups (noted in design, not part of this plan)

- Fix the `teamId: actor._id` bug in `packages/api/src/routers/api/admin.ts:217`.
- Consider whether `GET /admin/audit-log` should gain the same expanded filter set.
