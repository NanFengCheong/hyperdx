# Notification Log — Design Document

**Date:** 2026-04-09
**Status:** Approved
**Approach:** Single `notificationLog` MongoDB collection (Approach A)

## Overview

Unified notification log across all channels (email, webhook, future channels) with comprehensive filtering for debugging delivery status. Mirrors the audit log pattern with team-scoped + admin views.

## Data Model

```
NotificationLog {
  teamId        ObjectId (ref: Team, required)
  channel       String enum: 'email' | 'webhook' (extensible)
  status        String enum: 'pending' | 'success' | 'failed'
  recipient     String (email address, webhook URL, etc.)
  trigger       {
                  type: String,   // 'alert', 'system', 'user-action'
                  id: String,     // source entity ID
                  name: String    // human-readable trigger name
                }
  subject       String (email subject, webhook event name)
  payload       Mixed (full request body — email HTML, webhook JSON)
  response      Mixed (delivery response — SMTP reply, HTTP status+body)
  error         String (error message if failed, null otherwise)
  retryOf       ObjectId (ref: NotificationLog, null if original)
  actorId       ObjectId (ref: User, nullable for system-triggered)
  createdAt     Date (auto, timestamps: true, updatedAt: false)
}

Indexes:
  { teamId: 1, createdAt: -1 }
  { teamId: 1, channel: 1, createdAt: -1 }
  { teamId: 1, status: 1, createdAt: -1 }
  { recipient: 1, createdAt: -1 }
  { trigger.type: 1, trigger.id: 1 }
  { retryOf: 1 }
```

## API Routes

### Team-scoped (permission: roles:view)

**GET /team/notification-log**
- Query: `page` (default 0), `limit` (default 50, max 100)
- Filters: `channel`, `status`, `recipient` (regex), `triggerType`, `triggerId`, `fromDate`, `toDate`, `search` (fuzzy on recipient + subject)
- Response: `{ data: NotificationLog[], totalCount: number, page: number, limit: number }`

**POST /team/notification-log/:id/retry** (permission: roles:manage)
- Reads original log entry, re-invokes send with same payload
- Creates new entry with `retryOf: originalId`
- Response: `{ data: NotificationLog }` (the new retry entry)

### Admin (permission: super admin)

**GET /admin/notification-log**
- Same filters as team + `teamId` filter
- Response: same shape

**POST /admin/notification-log/:id/retry**
- Same as team retry

**GET /admin/notification-log/retention**
- Response: `{ retentionDays: number }`

**PUT /admin/notification-log/retention**
- Body: `{ retentionDays: number }`

## Logging Integration

Wrap existing send functions to auto-log:

1. **Before send:** Create NotificationLog entry with `status: 'pending'`
2. **On success:** Update to `status: 'success'`, store `response`
3. **On failure:** Update to `status: 'failed'`, store `error` + `response`

### Affected functions:
- `emailService.ts` — all `send*Email()` functions
- Alert webhook dispatch in `tasks/checkAlerts.ts`

### Helper:
```typescript
// utils/notificationLogger.ts
async function logNotification(params: {
  teamId: ObjectId;
  channel: 'email' | 'webhook';
  recipient: string;
  trigger: { type: string; id: string; name: string };
  subject: string;
  payload: any;
  actorId?: ObjectId;
  retryOf?: ObjectId;
}): Promise<NotificationLogDocument>

async function updateNotificationStatus(
  id: ObjectId,
  status: 'success' | 'failed',
  response?: any,
  error?: string
): Promise<void>
```

## UI Components

### Team Settings — NotificationLogSection.tsx
Mirrors AuditLogSection pattern:
- **Filter bar:** channel dropdown, status dropdown (with color badges), recipient text input, date range picker, trigger type dropdown
- **Table columns:** Date | Channel | Status (badge) | Recipient | Subject | Trigger | Actions
- **Row expand:** Full payload + response JSON viewer for debugging
- **Retry button:** On failed rows, triggers POST retry
- **Pagination:** Prev/next with page count

### Admin Page — Notification Log tab
Mirrors existing audit log tab:
- Same filters as team + team selector
- Retention settings panel (separate from audit log retention)
- Summary stats: total sent, success rate, failures by channel

### API Client Hooks (api.ts)
- `useTeamNotificationLog(page, limit, filters)`
- `useAdminNotificationLog(page, limit, filters)`
- `useRetryNotification()`

## Retention

- New platform setting: `notificationLogRetentionDays` (default: 30)
- Background task `cleanupNotificationLogs` — runs daily via existing task scheduler
- Independent from audit log retention
- Registered alongside existing cleanup tasks

## Retry Flow

1. User clicks "Retry" on a failed notification row
2. Frontend calls `POST /team/notification-log/:id/retry`
3. Backend loads original entry, validates it exists and is `failed`
4. Re-invokes the appropriate send function (email/webhook) with original payload
5. Creates new NotificationLog with `retryOf: originalId`
6. New entry goes through normal pending → success/failed flow
7. UI shows retry chain: original entry links to retry attempts

## Files to Create/Modify

### New files:
- `packages/api/src/models/notificationLog.ts` — Mongoose model
- `packages/api/src/utils/notificationLogger.ts` — logging helper
- `packages/api/src/tasks/cleanupNotificationLogs.ts` — retention task
- `packages/app/src/components/TeamSettings/NotificationLogSection.tsx` — team UI
- `packages/app/src/components/TeamSettings/NotificationLogFilters.tsx` — filter bar

### Modified files:
- `packages/api/src/utils/emailService.ts` — wrap send functions with logging
- `packages/api/src/tasks/checkAlerts.ts` — wrap webhook dispatch with logging
- `packages/api/src/routers/api/team.ts` — add team notification-log routes
- `packages/api/src/routers/api/admin.ts` — add admin notification-log routes
- `packages/app/src/components/TeamSettings/index.tsx` — add notification log tab
- `packages/app/src/AdminPage.tsx` — add notification log admin tab
- `packages/app/src/api.ts` — add React Query hooks
