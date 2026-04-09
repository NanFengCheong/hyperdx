# Notification Log — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a unified notification log (email + webhook + future channels) with comprehensive filtering, payload inspection, and retry for failed notifications.

**Architecture:** Single `notificationLog` MongoDB collection mirroring the audit log pattern. Logging helper wraps existing send functions. Team-scoped + admin views with filters. Separate data retention.

**Tech Stack:** MongoDB/Mongoose, Express, React/Next.js, Mantine UI, TanStack Query, Zod, nodemailer

**Design doc:** `docs/plans/2026-04-09-notification-log-design.md`

---

### Task 1: Create NotificationLog Mongoose Model

**Files:**
- Create: `packages/api/src/models/notificationLog.ts`

**Step 1: Create the model file**

```typescript
import mongoose, { Document } from 'mongoose';

export interface INotificationLog extends Document {
  teamId: mongoose.Types.ObjectId;
  channel: 'email' | 'webhook';
  status: 'pending' | 'success' | 'failed';
  recipient: string;
  trigger: {
    type: string;
    id: string;
    name: string;
  };
  subject: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  error: string | null;
  retryOf: mongoose.Types.ObjectId | null;
  actorId: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const NotificationLogSchema = new mongoose.Schema<INotificationLog>(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    channel: {
      type: String,
      required: true,
      enum: ['email', 'webhook'],
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
    },
    recipient: {
      type: String,
      required: true,
    },
    trigger: {
      type: {
        type: String,
        required: true,
      },
      id: {
        type: String,
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
    },
    subject: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    response: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    error: {
      type: String,
      default: null,
    },
    retryOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NotificationLog',
      default: null,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Team-scoped queries with date range
NotificationLogSchema.index({ teamId: 1, createdAt: -1 });
// Team-scoped channel filtering
NotificationLogSchema.index({ teamId: 1, channel: 1, createdAt: -1 });
// Team-scoped status filtering
NotificationLogSchema.index({ teamId: 1, status: 1, createdAt: -1 });
// Recipient search
NotificationLogSchema.index({ recipient: 1, createdAt: -1 });
// Trigger lookup
NotificationLogSchema.index({ 'trigger.type': 1, 'trigger.id': 1 });
// Retry chain
NotificationLogSchema.index({ retryOf: 1 });
// Global date range (admin + retention cleanup)
NotificationLogSchema.index({ createdAt: -1 });

export default mongoose.model<INotificationLog>(
  'NotificationLog',
  NotificationLogSchema,
);
```

**Step 2: Verify model compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/api/src/models/notificationLog.ts
git commit -m "feat(notification-log): add NotificationLog mongoose model"
```

---

### Task 2: Create Notification Logger Utility

**Files:**
- Create: `packages/api/src/utils/notificationLogger.ts`

**Step 1: Create the logger utility**

```typescript
import mongoose from 'mongoose';

import NotificationLog, {
  INotificationLog,
} from '@/models/notificationLog';
import logger from '@/utils/logger';

interface LogNotificationParams {
  teamId: mongoose.Types.ObjectId;
  channel: 'email' | 'webhook';
  recipient: string;
  trigger: { type: string; id: string; name: string };
  subject: string;
  payload: Record<string, unknown>;
  actorId?: mongoose.Types.ObjectId | null;
  retryOf?: mongoose.Types.ObjectId | null;
}

export async function createNotificationEntry(
  params: LogNotificationParams,
): Promise<INotificationLog> {
  try {
    return await NotificationLog.create({
      ...params,
      status: 'pending',
      actorId: params.actorId ?? null,
      retryOf: params.retryOf ?? null,
    });
  } catch (err) {
    logger.error({ err, params }, 'Failed to create notification log entry');
    throw err;
  }
}

export async function markNotificationSuccess(
  id: mongoose.Types.ObjectId,
  response?: Record<string, unknown>,
): Promise<void> {
  try {
    await NotificationLog.updateOne(
      { _id: id },
      { status: 'success', response: response ?? {} },
    );
  } catch (err) {
    logger.error({ err, id }, 'Failed to mark notification as success');
  }
}

export async function markNotificationFailed(
  id: mongoose.Types.ObjectId,
  error: string,
  response?: Record<string, unknown>,
): Promise<void> {
  try {
    await NotificationLog.updateOne(
      { _id: id },
      { status: 'failed', error, response: response ?? {} },
    );
  } catch (err) {
    logger.error({ err, id }, 'Failed to mark notification as failed');
  }
}
```

**Step 2: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/api/src/utils/notificationLogger.ts
git commit -m "feat(notification-log): add notification logger utility"
```

---

### Task 3: Integrate Logging into emailService.ts

**Files:**
- Modify: `packages/api/src/utils/emailService.ts`

**Context:** The `sendEmail()` function (line 34-55) is the single send point. All public functions (`sendLoginVerificationEmail`, `sendPasswordResetEmail`, `sendTeamInviteEmail`, `sendAlertNotificationEmail`) call it. We need to add an optional notification context parameter that flows through.

**Step 1: Add notification context type and modify sendEmail**

Add a `NotificationContext` interface and an optional param to `sendEmail`. When context is provided, create a log entry before send, update status after.

```typescript
// Add imports at top
import mongoose from 'mongoose';
import {
  createNotificationEntry,
  markNotificationFailed,
  markNotificationSuccess,
} from '@/utils/notificationLogger';

// Add interface after SendEmailOptions
interface NotificationContext {
  teamId: mongoose.Types.ObjectId;
  trigger: { type: string; id: string; name: string };
  actorId?: mongoose.Types.ObjectId | null;
  retryOf?: mongoose.Types.ObjectId | null;
}

// Modify sendEmail signature to accept optional context
async function sendEmail(
  options: SendEmailOptions,
  context?: NotificationContext,
): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    logger.warn('SMTP not configured, skipping email send');
    return true;
  }

  let logEntry: any = null;
  if (context) {
    try {
      logEntry = await createNotificationEntry({
        teamId: context.teamId,
        channel: 'email',
        recipient: options.to,
        trigger: context.trigger,
        subject: options.subject,
        payload: { html: options.html, text: options.text },
        actorId: context.actorId,
        retryOf: context.retryOf,
      });
    } catch {
      // logging failure should not block email send
    }
  }

  try {
    const info = await transport.sendMail({
      from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_FROM}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    logger.info({ to: options.to, subject: options.subject }, 'Email sent');
    if (logEntry) {
      await markNotificationSuccess(logEntry._id, {
        messageId: info.messageId,
        response: info.response,
      });
    }
    return true;
  } catch (error) {
    logger.error({ err: error, to: options.to }, 'Failed to send email');
    if (logEntry) {
      await markNotificationFailed(
        logEntry._id,
        error instanceof Error ? error.message : String(error),
      );
    }
    return false;
  }
}
```

**Step 2: Add optional context param to all public send functions**

Each public function gets an optional `context?: NotificationContext` param that passes through to `sendEmail`:

```typescript
export async function sendLoginVerificationEmail(
  to: string,
  name: string,
  code: string,
  magicLink: string,
  context?: NotificationContext,
): Promise<boolean> {
  const { html, text } = await renderLoginVerification({ name, code, magicLink });
  return sendEmail({ to, subject: `Your verification code: ${code}`, html, text }, context);
}
```

Same pattern for `sendPasswordResetEmail`, `sendTeamInviteEmail`, `sendAlertNotificationEmail`.

**Step 3: Export the NotificationContext type**

Add at bottom: `export type { NotificationContext };`

**Step 4: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/utils/emailService.ts
git commit -m "feat(notification-log): integrate logging into email service"
```

---

### Task 4: Integrate Logging into Webhook Dispatch (checkAlerts.ts)

**Files:**
- Modify: `packages/api/src/tasks/checkAlerts.ts`

**Step 1: Read checkAlerts.ts to find exact webhook send locations**

Read the file to find `handleSendGenericWebhook` and any other webhook dispatch functions. Identify teamId availability.

**Step 2: Wrap webhook dispatch with notification logging**

Add imports for `createNotificationEntry`, `markNotificationSuccess`, `markNotificationFailed`.

Before each webhook `fetch()` call, create a notification entry with `channel: 'webhook'`. After fetch resolves, update status based on HTTP response code. On catch, mark failed.

Pattern:
```typescript
import {
  createNotificationEntry,
  markNotificationFailed,
  markNotificationSuccess,
} from '@/utils/notificationLogger';

// Inside webhook send function, wrap the fetch:
const logEntry = await createNotificationEntry({
  teamId: alert.teamId,
  channel: 'webhook',
  recipient: webhook.url,
  trigger: { type: 'alert', id: String(alert._id), name: alert.name ?? 'Unnamed Alert' },
  subject: webhook.name ?? 'Webhook notification',
  payload: { body: message, queryParams: webhook.queryParams },
});

try {
  const resp = await fetch(url, fetchOptions);
  if (resp.ok) {
    await markNotificationSuccess(logEntry._id, {
      status: resp.status,
      statusText: resp.statusText,
    });
  } else {
    const body = await resp.text().catch(() => '');
    await markNotificationFailed(logEntry._id, `HTTP ${resp.status}: ${resp.statusText}`, {
      status: resp.status,
      body: body.slice(0, 1000),
    });
  }
} catch (error) {
  await markNotificationFailed(
    logEntry._id,
    error instanceof Error ? error.message : String(error),
  );
}
```

**Step 3: Similarly wrap email sends in checkAlerts** — pass `NotificationContext` with `teamId` and alert trigger info to `sendAlertNotificationEmail`.

**Step 4: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/tasks/checkAlerts.ts
git commit -m "feat(notification-log): integrate logging into alert webhook/email dispatch"
```

---

### Task 5: Add Team Notification Log API Routes

**Files:**
- Modify: `packages/api/src/routers/api/team.ts`

**Step 1: Add imports**

At top of team.ts, add:
```typescript
import NotificationLog from '@/models/notificationLog';
```

**Step 2: Add GET /team/notification-log route**

Add after the existing audit-log route (follows same pattern):

```typescript
router.get(
  '/notification-log',
  requirePermission('roles:view'),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const page = parseInt(req.query.page as string) || 0;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

      const filter: Record<string, any> = { teamId };

      if (req.query.channel) {
        filter.channel = req.query.channel;
      }
      if (req.query.status) {
        filter.status = req.query.status;
      }
      if (req.query.recipient) {
        filter.recipient = { $regex: req.query.recipient, $options: 'i' };
      }
      if (req.query.triggerType) {
        filter['trigger.type'] = req.query.triggerType;
      }
      if (req.query.triggerId) {
        filter['trigger.id'] = req.query.triggerId;
      }
      if (req.query.fromDate || req.query.toDate) {
        filter.createdAt = {};
        if (req.query.fromDate) {
          filter.createdAt.$gte = new Date(req.query.fromDate as string);
        }
        if (req.query.toDate) {
          filter.createdAt.$lte = new Date(req.query.toDate as string);
        }
      }
      if (req.query.search) {
        const search = req.query.search as string;
        filter.$or = [
          { recipient: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
        ];
      }

      const [data, totalCount] = await Promise.all([
        NotificationLog.find(filter)
          .sort({ createdAt: -1 })
          .skip(page * limit)
          .limit(limit),
        NotificationLog.countDocuments(filter),
      ]);

      res.json({ data, totalCount, page, limit });
    } catch (e) {
      next(e);
    }
  },
);
```

**Step 3: Add POST /team/notification-log/:id/retry route**

```typescript
router.post(
  '/notification-log/:id/retry',
  requirePermission('roles:manage'),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const original = await NotificationLog.findOne({
        _id: req.params.id,
        teamId,
        status: 'failed',
      });

      if (!original) {
        return res.status(404).json({ message: 'Notification not found or not failed' });
      }

      if (original.channel === 'email') {
        // Re-send via emailService — import sendEmail or reconstruct
        const { sendEmail } = await import('@/utils/emailService');
        const logEntry = await createNotificationEntry({
          teamId: original.teamId,
          channel: 'email',
          recipient: original.recipient,
          trigger: original.trigger,
          subject: original.subject,
          payload: original.payload as Record<string, unknown>,
          retryOf: original._id,
        });

        try {
          const transport = getTransporter();
          if (!transport) {
            await markNotificationFailed(logEntry._id, 'SMTP not configured');
            return res.json({ data: logEntry });
          }
          const info = await transport.sendMail({
            from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_FROM}>`,
            to: original.recipient,
            subject: original.subject,
            html: (original.payload as any)?.html ?? '',
            text: (original.payload as any)?.text ?? '',
          });
          await markNotificationSuccess(logEntry._id, {
            messageId: info.messageId,
            response: info.response,
          });
          const updated = await NotificationLog.findById(logEntry._id);
          return res.json({ data: updated });
        } catch (error) {
          await markNotificationFailed(
            logEntry._id,
            error instanceof Error ? error.message : String(error),
          );
          const updated = await NotificationLog.findById(logEntry._id);
          return res.json({ data: updated });
        }
      }

      if (original.channel === 'webhook') {
        const logEntry = await createNotificationEntry({
          teamId: original.teamId,
          channel: 'webhook',
          recipient: original.recipient,
          trigger: original.trigger,
          subject: original.subject,
          payload: original.payload as Record<string, unknown>,
          retryOf: original._id,
        });

        try {
          const resp = await fetch(original.recipient, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify((original.payload as any)?.body ?? {}),
          });
          if (resp.ok) {
            await markNotificationSuccess(logEntry._id, {
              status: resp.status,
              statusText: resp.statusText,
            });
          } else {
            const body = await resp.text().catch(() => '');
            await markNotificationFailed(logEntry._id, `HTTP ${resp.status}`, {
              status: resp.status,
              body: body.slice(0, 1000),
            });
          }
          const updated = await NotificationLog.findById(logEntry._id);
          return res.json({ data: updated });
        } catch (error) {
          await markNotificationFailed(
            logEntry._id,
            error instanceof Error ? error.message : String(error),
          );
          const updated = await NotificationLog.findById(logEntry._id);
          return res.json({ data: updated });
        }
      }

      return res.status(400).json({ message: `Unsupported channel: ${original.channel}` });
    } catch (e) {
      next(e);
    }
  },
);
```

**Note:** The retry route is verbose — after the initial implementation works, consider extracting a `retryNotification()` helper into `notificationLogger.ts` in a follow-up refactor. For now, keep it inline to match the codebase pattern of routes containing logic directly.

**Step 4: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/team.ts
git commit -m "feat(notification-log): add team notification-log API routes (list + retry)"
```

---

### Task 6: Add Admin Notification Log API Routes

**Files:**
- Modify: `packages/api/src/routers/api/admin.ts`

**Step 1: Add imports**

```typescript
import NotificationLog from '../../models/notificationLog';
```

**Step 2: Add GET /admin/notification-log route**

Same as team route but without teamId scoping (unless `teamId` query param provided):

```typescript
router.get('/notification-log', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const filter: Record<string, any> = {};

    if (req.query.teamId) {
      filter.teamId = req.query.teamId;
    }
    if (req.query.channel) {
      filter.channel = req.query.channel;
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.recipient) {
      filter.recipient = { $regex: req.query.recipient, $options: 'i' };
    }
    if (req.query.triggerType) {
      filter['trigger.type'] = req.query.triggerType;
    }
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) {
        filter.createdAt.$gte = new Date(req.query.fromDate as string);
      }
      if (req.query.toDate) {
        filter.createdAt.$lte = new Date(req.query.toDate as string);
      }
    }
    if (req.query.search) {
      const search = req.query.search as string;
      filter.$or = [
        { recipient: { $regex: search, $options: 'i' } },
        { subject: { $regex: search, $options: 'i' } },
      ];
    }

    const [data, totalCount] = await Promise.all([
      NotificationLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit),
      NotificationLog.countDocuments(filter),
    ]);

    res.json({ data, totalCount, page, limit });
  } catch (e) {
    next(e);
  }
});
```

**Step 3: Add retention routes**

```typescript
router.get('/notification-log/retention', async (req, res, next) => {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'notificationLogRetentionDays',
    });
    res.json({ retentionDays: setting?.value ?? 30 });
  } catch (e) {
    next(e);
  }
});

router.put('/notification-log/retention', async (req, res, next) => {
  try {
    const { retentionDays } = req.body;
    if (typeof retentionDays !== 'number' || retentionDays < 1) {
      return res.status(400).json({ message: 'retentionDays must be a positive number' });
    }
    await PlatformSetting.findOneAndUpdate(
      { key: 'notificationLogRetentionDays' },
      { key: 'notificationLogRetentionDays', value: retentionDays },
      { upsert: true },
    );
    res.json({ retentionDays });
  } catch (e) {
    next(e);
  }
});
```

**Step 4: Add admin retry route** (same logic as team retry but without teamId filter)

```typescript
router.post('/notification-log/:id/retry', async (req, res, next) => {
  // Same as team retry but find by _id only (no teamId filter)
  // ... (mirror Task 5 Step 3 logic without teamId constraint)
});
```

**Step 5: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/api/src/routers/api/admin.ts
git commit -m "feat(notification-log): add admin notification-log routes (list + retry + retention)"
```

---

### Task 7: Add Notification Log Retention Cleanup Task

**Files:**
- Create: `packages/api/src/tasks/cleanupNotificationLogs.ts`

**Step 1: Read existing retention task for pattern**

Read `packages/api/src/tasks/dataRetention.ts` to see how existing cleanup tasks are structured and scheduled.

**Step 2: Create cleanup task**

```typescript
import NotificationLog from '@/models/notificationLog';
import PlatformSetting from '@/models/platformSetting';
import logger from '@/utils/logger';

const DEFAULT_RETENTION_DAYS = 30;

export async function cleanupNotificationLogs(): Promise<void> {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'notificationLogRetentionDays',
    });
    const retentionDays = (setting?.value as number) ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await NotificationLog.deleteMany({
      createdAt: { $lt: cutoff },
    });

    logger.info(
      { deletedCount: result.deletedCount, retentionDays },
      'Notification log cleanup complete',
    );
  } catch (err) {
    logger.error({ err }, 'Notification log cleanup failed');
  }
}
```

**Step 3: Register in existing task scheduler**

Find where `DataRetentionTask` or periodic tasks are scheduled (likely in `packages/api/src/tasks/index.ts` or the main app setup). Add `cleanupNotificationLogs` to run on the same daily schedule.

**Step 4: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/tasks/cleanupNotificationLogs.ts
git commit -m "feat(notification-log): add daily retention cleanup task"
```

---

### Task 8: Add Frontend API Hooks

**Files:**
- Modify: `packages/app/src/api.ts`

**Step 1: Add notification log filter type and hooks**

Add near the existing `useTeamAuditLog` and `useAdminAuditLog` hooks:

```typescript
// Types
interface NotificationLogFilters {
  channel?: string;
  status?: string;
  recipient?: string;
  triggerType?: string;
  triggerId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
}

// Team hook
useTeamNotificationLog(page = 0, limit = 50, filters?: NotificationLogFilters) {
  return useQuery({
    queryKey: ['team/notification-log', page, limit, filters],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (filters?.channel) params.set('channel', filters.channel);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.recipient) params.set('recipient', filters.recipient);
      if (filters?.triggerType) params.set('triggerType', filters.triggerType);
      if (filters?.triggerId) params.set('triggerId', filters.triggerId);
      if (filters?.fromDate) params.set('fromDate', filters.fromDate);
      if (filters?.toDate) params.set('toDate', filters.toDate);
      if (filters?.search) params.set('search', filters.search);
      return hdxServer(`team/notification-log?${params}`).json<{
        data: any[];
        totalCount: number;
        page: number;
        limit: number;
      }>();
    },
  });
},

// Admin hook
useAdminNotificationLog(page = 0, limit = 50, filters?: NotificationLogFilters & { teamId?: string }) {
  return useQuery({
    queryKey: ['admin/notification-log', page, limit, filters],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (filters?.teamId) params.set('teamId', filters.teamId);
      if (filters?.channel) params.set('channel', filters.channel);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.recipient) params.set('recipient', filters.recipient);
      if (filters?.triggerType) params.set('triggerType', filters.triggerType);
      if (filters?.fromDate) params.set('fromDate', filters.fromDate);
      if (filters?.toDate) params.set('toDate', filters.toDate);
      if (filters?.search) params.set('search', filters.search);
      return hdxServer(`admin/notification-log?${params}`).json<{
        data: any[];
        totalCount: number;
        page: number;
        limit: number;
      }>();
    },
  });
},

// Retry mutation
useRetryNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hdxServer(`team/notification-log/${id}/retry`, { method: 'POST' }).json<{
        data: any;
      }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team/notification-log'] });
    },
  });
},

// Admin retry mutation
useAdminRetryNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hdxServer(`admin/notification-log/${id}/retry`, { method: 'POST' }).json<{
        data: any;
      }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin/notification-log'] });
    },
  });
},

// Retention hooks
useAdminNotificationLogRetention() {
  return useQuery({
    queryKey: ['admin/notification-log/retention'],
    queryFn: () =>
      hdxServer('admin/notification-log/retention').json<{
        retentionDays: number;
      }>(),
  });
},

useUpdateAdminNotificationLogRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) =>
      hdxServer('admin/notification-log/retention', {
        method: 'PUT',
        json: { retentionDays },
      }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin/notification-log/retention'],
      });
    },
  });
},
```

**Step 2: Verify compiles**

Run: `cd packages/app && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/app/src/api.ts
git commit -m "feat(notification-log): add frontend API hooks for notification log"
```

---

### Task 9: Create Team NotificationLogSection UI Component

**Files:**
- Create: `packages/app/src/components/TeamSettings/NotificationLogSection.tsx`

**Step 1: Create the component**

Model after `AuditLogSection.tsx` but with filters and expandable rows:

```typescript
import { useState } from 'react';
import {
  Badge,
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
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';

import api from '@/api';

const PAGE_SIZE = 50;

const STATUS_COLORS: Record<string, string> = {
  pending: 'yellow',
  success: 'green',
  failed: 'red',
};

const CHANNEL_OPTIONS = [
  { value: '', label: 'All Channels' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

export default function NotificationLogSection() {
  const [page, setPage] = useState(0);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [recipient, setRecipient] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = {
    channel: channel || undefined,
    status: status || undefined,
    recipient: recipient || undefined,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    search: search || undefined,
  };

  const { data: notifLog, isLoading } = api.useTeamNotificationLog(
    page,
    PAGE_SIZE,
    filters,
  );
  const retryMutation = api.useRetryNotification();

  const totalCount = notifLog?.totalCount ?? 0;
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

  const handleRetry = (id: string) => {
    retryMutation.mutate(id);
  };

  const resetFilters = () => {
    setChannel('');
    setStatus('');
    setRecipient('');
    setSearch('');
    setFromDate(null);
    setToDate(null);
    setPage(0);
  };

  return (
    <Box id="notification-log" data-testid="notification-log-section">
      <Text size="md">Notification Log</Text>
      <Divider my="md" />

      {/* Filters */}
      <Group mb="md" gap="sm" wrap="wrap">
        <Select
          size="xs"
          placeholder="Channel"
          data={CHANNEL_OPTIONS}
          value={channel}
          onChange={v => { setChannel(v ?? ''); setPage(0); }}
          clearable
          w={140}
        />
        <Select
          size="xs"
          placeholder="Status"
          data={STATUS_OPTIONS}
          value={status}
          onChange={v => { setStatus(v ?? ''); setPage(0); }}
          clearable
          w={140}
        />
        <TextInput
          size="xs"
          placeholder="Recipient"
          value={recipient}
          onChange={e => { setRecipient(e.currentTarget.value); setPage(0); }}
          w={200}
        />
        <TextInput
          size="xs"
          placeholder="Search subject/recipient"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={e => { setSearch(e.currentTarget.value); setPage(0); }}
          w={220}
        />
        <DatePickerInput
          size="xs"
          placeholder="From date"
          value={fromDate}
          onChange={v => { setFromDate(v); setPage(0); }}
          clearable
          w={150}
        />
        <DatePickerInput
          size="xs"
          placeholder="To date"
          value={toDate}
          onChange={v => { setToDate(v); setPage(0); }}
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
                <Table.Th>Channel</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Recipient</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Trigger</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoading &&
                Array.isArray(notifLog?.data) &&
                notifLog.data.map((entry: any) => (
                  <>
                    <Table.Tr
                      key={entry._id}
                      onClick={() =>
                        setExpandedId(expandedId === entry._id ? null : entry._id)
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
                        <Badge size="xs" variant="light">
                          {entry.channel}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="xs"
                          color={STATUS_COLORS[entry.status] ?? 'gray'}
                        >
                          {entry.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate style={{ maxWidth: 200 }}>
                          {entry.recipient}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate style={{ maxWidth: 200 }}>
                          {entry.subject ?? '\u2014'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {entry.trigger?.name ?? '\u2014'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {entry.status === 'failed' && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            leftSection={<IconRefresh size={14} />}
                            loading={retryMutation.isPending}
                            onClick={e => {
                              e.stopPropagation();
                              handleRetry(entry._id);
                            }}
                          >
                            Retry
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                    {expandedId === entry._id && (
                      <Table.Tr key={`${entry._id}-detail`}>
                        <Table.Td colSpan={8}>
                          <Collapse in={expandedId === entry._id}>
                            <Box p="sm">
                              {entry.error && (
                                <Box mb="xs">
                                  <Text size="xs" fw={600} c="red">
                                    Error:
                                  </Text>
                                  <Code block>{entry.error}</Code>
                                </Box>
                              )}
                              <Text size="xs" fw={600} mb={4}>
                                Payload:
                              </Text>
                              <Code block>
                                {JSON.stringify(entry.payload, null, 2)}
                              </Code>
                              {entry.response &&
                                Object.keys(entry.response).length > 0 && (
                                  <Box mt="xs">
                                    <Text size="xs" fw={600} mb={4}>
                                      Response:
                                    </Text>
                                    <Code block>
                                      {JSON.stringify(entry.response, null, 2)}
                                    </Code>
                                  </Box>
                                )}
                              {entry.retryOf && (
                                <Text size="xs" c="dimmed" mt="xs">
                                  Retry of: {entry.retryOf}
                                </Text>
                              )}
                            </Box>
                          </Collapse>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </>
                ))}
              {!isLoading &&
                (!notifLog?.data || notifLog.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={8}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No notification log entries found.
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

**Step 2: Verify compiles**

Run: `cd packages/app && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/app/src/components/TeamSettings/NotificationLogSection.tsx
git commit -m "feat(notification-log): add team notification log UI component with filters"
```

---

### Task 10: Add Notification Log Tab to Team Settings

**Files:**
- Modify: `packages/app/src/TeamPage.tsx` (the file that contains the tabs array)

**Step 1: Add import**

```typescript
import NotificationLogSection from '@/components/TeamSettings/NotificationLogSection';
```

**Step 2: Add tab entry to the `tabs` array**

Insert after the audit-log tab entry:

```typescript
{
  value: 'notification-log',
  label: 'Notification Log',
  subtabs: [
    { value: 'notification-log', label: 'Notification Log', content: <NotificationLogSection /> },
  ],
},
```

**Step 3: Verify compiles**

Run: `cd packages/app && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/app/src/TeamPage.tsx
git commit -m "feat(notification-log): add notification log tab to team settings"
```

---

### Task 11: Add Admin Notification Log Tab to AdminPage

**Files:**
- Modify: `packages/app/src/AdminPage.tsx`

**Step 1: Create NotificationLogPanel component inside AdminPage**

Model after the existing `AuditLogPanel`. Same filter bar as team version but with additional team selector. Add retention settings section below.

```typescript
function NotificationLogPanel() {
  const [page, setPage] = useState(0);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [recipient, setRecipient] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);

  const filters = {
    channel: channel || undefined,
    status: status || undefined,
    recipient: recipient || undefined,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    search: search || undefined,
  };

  const { data, isLoading } = api.useAdminNotificationLog(page, PAGE_SIZE, filters);
  const retryMutation = api.useAdminRetryNotification();
  const { data: retention } = api.useAdminNotificationLogRetention();
  const updateRetention = api.useUpdateAdminNotificationLogRetention();

  // ... same table/filter UI as NotificationLogSection
  // ... plus retention settings input
}
```

**Step 2: Add tab to AdminPage tabs**

```typescript
<Tabs.Tab value="notification-log">Notification Log</Tabs.Tab>
// ...
<Tabs.Panel value="notification-log">
  <NotificationLogPanel />
</Tabs.Panel>
```

**Step 3: Verify compiles**

Run: `cd packages/app && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/app/src/AdminPage.tsx
git commit -m "feat(notification-log): add notification log admin tab with retention settings"
```

---

### Task 12: Pass NotificationContext from Callers

**Files:**
- Modify: files that call `sendAlertNotificationEmail`, `sendTeamInviteEmail`, etc.

**Step 1: Find all call sites**

Run: `grep -rn 'sendAlertNotificationEmail\|sendTeamInviteEmail\|sendLoginVerificationEmail\|sendPasswordResetEmail' packages/api/src/ --include='*.ts'`

**Step 2: For each call site, add NotificationContext**

Each caller needs to pass `{ teamId, trigger: { type, id, name } }`. Example for alert emails in `checkAlerts.ts`:

```typescript
await sendAlertNotificationEmail(options, {
  teamId: alert.teamId,
  trigger: { type: 'alert', id: String(alert._id), name: alert.name ?? 'Alert' },
});
```

For team invites:
```typescript
await sendTeamInviteEmail(to, invitedByEmail, joinUrl, {
  teamId,
  trigger: { type: 'user-action', id: String(userId), name: 'Team invite' },
  actorId: userId,
});
```

For login/password emails (no teamId available — these are pre-auth): skip context or use a system teamId placeholder. Decision: skip notification logging for auth emails initially, since they don't have team context and aren't debugging targets.

**Step 3: Verify compiles**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | distill "Did it compile? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/api/src/
git commit -m "feat(notification-log): pass NotificationContext from alert and invite callers"
```

---

### Task 13: Lint and Type Check Full Project

**Step 1: Run full lint**

Run: `make ci-lint 2>&1 | distill "Did lint pass? Return PASS or FAIL with errors if any."`
Expected: PASS

**Step 2: Fix any lint errors found**

**Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix(notification-log): lint and type fixes"
```

---

### Task 14: Manual Smoke Test

**Step 1: Start dev stack**

Run: `yarn dev`

**Step 2: Verify team notification log page loads**

Navigate to Team Settings → Notification Log tab. Should show empty state.

**Step 3: Trigger a test alert notification**

Create an alert, trigger it, verify the notification appears in the log with correct channel/status/payload.

**Step 4: Test filters**

Filter by channel, status, date range. Verify results update.

**Step 5: Test retry**

If any failed notifications exist, click retry. Verify new entry created with `retryOf` link.

**Step 6: Test admin view**

Navigate to Admin → Notification Log tab. Verify global view with all teams. Test retention settings.
