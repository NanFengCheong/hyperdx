# Custom Groups (RBAC) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Custom Groups feature to ClickStack — RBAC with group-based permissions (Read-only / Read and Write) and data scope filtering, matching the HyperDX cloud UI.

**Architecture:** Add a `Group` Mongoose model with name, accountAccess, and dataScope fields. CRUD API routes on `/team/groups`. Frontend `GroupsSection` component in TeamSettings with create/edit modals. Users are assigned to groups via `groupId` on the User model. Data scope filtering is applied server-side via the group's search filter.

**Tech Stack:** Mongoose, Express, Zod, Mantine UI, TanStack Query

---

## Prerequisites

All file paths are relative to the HyperDX repo root (`clickstack/`).
Working branch: `main` (or `feat/custom-groups`).

---

### Task 1: Add Group Mongoose Model

**Files:**
- Create: `packages/api/src/models/group.ts`

**Step 1: Create the Group model**

```typescript
import mongoose, { Schema } from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

export interface IGroup {
  _id: ObjectId;
  name: string;
  teamId: ObjectId;
  accountAccess: 'read-only' | 'read-write';
  dataScope: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GroupDocument = mongoose.HydratedDocument<IGroup>;

const GroupSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    accountAccess: {
      type: String,
      enum: ['read-only', 'read-write'],
      default: 'read-only',
    },
    dataScope: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

// Compound index: group names are unique within a team
GroupSchema.index({ teamId: 1, name: 1 }, { unique: true });

export default mongoose.model<IGroup>('Group', GroupSchema);
```

**Step 2: Commit**

```bash
git add packages/api/src/models/group.ts
git commit -m "feat(api): add Group model for RBAC custom groups"
```

---

### Task 2: Add groupId to User Model

**Files:**
- Modify: `packages/api/src/models/user.ts`

**Step 1: Add groupId field to IUser interface**

In the `IUser` interface, add:

```typescript
groupId?: ObjectId;
```

**Step 2: Add groupId to the Mongoose schema**

In the `UserSchema` definition, add alongside existing fields:

```typescript
groupId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'Group',
},
```

**Step 3: Commit**

```bash
git add packages/api/src/models/user.ts
git commit -m "feat(api): add groupId field to User model for group assignment"
```

---

### Task 3: Add Group Zod Types to common-utils

**Files:**
- Modify: `packages/common-utils/src/types.ts`

**Step 1: Add GroupSchema and API response types**

After the existing `TeamMemberSchema`, add:

```typescript
export const GroupSchema = z.object({
  _id: z.string(),
  name: z.string(),
  teamId: z.string(),
  accountAccess: z.enum(['read-only', 'read-write']),
  dataScope: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Group = z.infer<typeof GroupSchema>;

export const GroupsApiResponseSchema = z.object({
  data: z.array(GroupSchema),
});

export type GroupsApiResponse = z.infer<typeof GroupsApiResponseSchema>;
```

**Step 2: Add groupName to TeamMemberSchema (if not already present)**

The `TeamMemberSchema` already has `groupName: z.string().optional()`. Add `groupId` too:

```typescript
groupId: z.string().optional(),
```

**Step 3: Commit**

```bash
git add packages/common-utils/src/types.ts
git commit -m "feat(common-utils): add Group types and API response schemas"
```

---

### Task 4: Add Group CRUD API Routes

**Files:**
- Modify: `packages/api/src/routers/api/team.ts`

**Step 1: Import Group model and types**

At the top of `team.ts`, add:

```typescript
import Group from '@/models/group';
```

Import `GroupsApiResponse` from common-utils if types are used for the response.

**Step 2: Add GET /team/groups route**

After the existing `GET /members` route, add:

```typescript
router.get('/groups', async (req, res, next) => {
  try {
    const teamId = req.user?.team;
    if (!teamId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const groups = await Group.find({ teamId }).sort({ createdAt: -1 });
    res.json({
      data: groups.map(g => g.toJSON()),
    });
  } catch (e) {
    next(e);
  }
});
```

**Step 3: Add POST /team/group route (create)**

```typescript
router.post(
  '/group',
  validateRequest({
    body: z.object({
      name: z.string().min(1).max(100),
      accountAccess: z.enum(['read-only', 'read-write']),
      dataScope: z.string().max(1000).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (!teamId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const { name, accountAccess, dataScope } = req.body;
      const group = new Group({
        name,
        teamId,
        accountAccess,
        dataScope: dataScope || '',
      });
      await group.save();
      res.json({ data: group.toJSON() });
    } catch (e: any) {
      if (e.code === 11000) {
        return res.status(409).json({ message: 'A group with this name already exists' });
      }
      next(e);
    }
  },
);
```

**Step 4: Add PATCH /team/group/:id route (update)**

```typescript
router.patch(
  '/group/:id',
  validateRequest({
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      name: z.string().min(1).max(100).optional(),
      accountAccess: z.enum(['read-only', 'read-write']).optional(),
      dataScope: z.string().max(1000).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (!teamId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const group = await Group.findOneAndUpdate(
        { _id: req.params.id, teamId },
        { $set: req.body },
        { new: true, runValidators: true },
      );
      if (!group) {
        return res.status(404).json({ message: 'Group not found' });
      }
      res.json({ data: group.toJSON() });
    } catch (e: any) {
      if (e.code === 11000) {
        return res.status(409).json({ message: 'A group with this name already exists' });
      }
      next(e);
    }
  },
);
```

**Step 5: Add DELETE /team/group/:id route**

```typescript
router.delete(
  '/group/:id',
  validateRequest({
    params: z.object({ id: objectIdSchema }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (!teamId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      // Unassign all users from this group first
      await User.updateMany(
        { team: teamId, groupId: req.params.id },
        { $unset: { groupId: '' } },
      );
      const group = await Group.findOneAndDelete({
        _id: req.params.id,
        teamId,
      });
      if (!group) {
        return res.status(404).json({ message: 'Group not found' });
      }
      res.json({});
    } catch (e) {
      next(e);
    }
  },
);
```

**Step 6: Add PATCH /team/member/:id/group route (assign user to group)**

```typescript
router.patch(
  '/member/:id/group',
  validateRequest({
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      groupId: z.string().nullable(),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (!teamId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const { groupId } = req.body;

      // Verify group belongs to this team (if assigning)
      if (groupId) {
        const group = await Group.findOne({ _id: groupId, teamId });
        if (!group) {
          return res.status(404).json({ message: 'Group not found' });
        }
      }

      const update = groupId
        ? { $set: { groupId } }
        : { $unset: { groupId: '' } };

      const user = await User.findOneAndUpdate(
        { _id: req.params.id, team: teamId },
        update,
        { new: true },
      );
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json({});
    } catch (e) {
      next(e);
    }
  },
);
```

**Step 7: Update GET /team/members to include groupName**

In the existing `GET /members` route, update the member mapping to look up the group name. Replace the current member map with:

```typescript
const groups = await Group.find({ teamId });
const groupMap = new Map(groups.map(g => [g._id.toString(), g]));

res.json({
  data: teamUsers.map(user => {
    const userJson = user.toJSON({ virtuals: true });
    const group = (userJson as any).groupId
      ? groupMap.get((userJson as any).groupId.toString())
      : null;
    return {
      ...pick(userJson, [
        '_id',
        'email',
        'name',
        'hasPasswordAuth',
        'authMethod',
      ]),
      isCurrentUser: user._id.equals(userId),
      groupId: (userJson as any).groupId?.toString() || null,
      groupName: group?.name || null,
    };
  }),
});
```

**Step 8: Commit**

```bash
git add packages/api/src/routers/api/team.ts
git commit -m "feat(api): add Group CRUD routes and member group assignment"
```

---

### Task 5: Add Group API Hooks to Frontend

**Files:**
- Modify: `packages/app/src/api.ts`

**Step 1: Add group hooks to the api object**

Add these hooks in the `api` object alongside the existing team hooks:

```typescript
useTeamGroups() {
  return useQuery<{ data: any[] }>({
    queryKey: ['team/groups'],
    queryFn: () => hdxServer('team/groups').json<{ data: any[] }>(),
  });
},

useCreateGroup() {
  return useMutation<any, Error | HTTPError, {
    name: string;
    accountAccess: 'read-only' | 'read-write';
    dataScope?: string;
  }>({
    mutationFn: async (body) =>
      hdxServer('team/group', { method: 'POST', json: body }).json(),
  });
},

useUpdateGroup() {
  return useMutation<any, Error | HTTPError, {
    id: string;
    name?: string;
    accountAccess?: 'read-only' | 'read-write';
    dataScope?: string;
  }>({
    mutationFn: async ({ id, ...body }) =>
      hdxServer(`team/group/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: body,
      }).json(),
  });
},

useDeleteGroup() {
  return useMutation<any, Error | HTTPError, { id: string }>({
    mutationFn: async ({ id }) =>
      hdxServer(`team/group/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).json(),
  });
},

useAssignMemberGroup() {
  return useMutation<any, Error | HTTPError, {
    userId: string;
    groupId: string | null;
  }>({
    mutationFn: async ({ userId, groupId }) =>
      hdxServer(`team/member/${encodeURIComponent(userId)}/group`, {
        method: 'PATCH',
        json: { groupId },
      }).json(),
  });
},
```

**Step 2: Commit**

```bash
git add packages/app/src/api.ts
git commit -m "feat(app): add group CRUD and member assignment API hooks"
```

---

### Task 6: Create GroupsSection Frontend Component

**Files:**
- Create: `packages/app/src/components/TeamSettings/GroupsSection.tsx`

**Step 1: Create the component**

Build a `GroupsSection` component following the existing `TeamMembersSection` pattern:

- Groups list in a `Card` with table layout
- Each row: group icon + name, badges (account access + data scope), last edited date, Delete + Edit buttons
- "New Custom Group" button in the card header
- Create/Edit modal with: Group Name input, Account Access toggle (Read-only / Read and Write), Data Scope input
- Delete confirmation

The component should:
1. Use `api.useTeamGroups()` to fetch groups
2. Use `api.useCreateGroup()`, `api.useUpdateGroup()`, `api.useDeleteGroup()` for mutations
3. Refetch groups after mutations
4. Show notifications on success/error

```tsx
import { useState } from 'react';
import { HTTPError } from 'ky';
import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconFilter,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconTrash,
  IconUsers,
  IconUsersPlus,
} from '@tabler/icons-react';

import api from '@/api';

interface GroupData {
  _id: string;
  name: string;
  accountAccess: 'read-only' | 'read-write';
  dataScope: string;
  updatedAt: string;
}

interface GroupFormState {
  name: string;
  accountAccess: 'read-only' | 'read-write';
  dataScope: string;
}

const defaultFormState: GroupFormState = {
  name: '',
  accountAccess: 'read-only',
  dataScope: '',
};

export default function GroupsSection() {
  const { data: groupsData, refetch } = api.useTeamGroups();
  const createGroup = api.useCreateGroup();
  const updateGroup = api.useUpdateGroup();
  const deleteGroup = api.useDeleteGroup();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<GroupData | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<GroupData | null>(null);
  const [form, setForm] = useState<GroupFormState>(defaultFormState);

  const groups: GroupData[] = groupsData?.data || [];

  const handleOpenCreate = () => {
    setForm(defaultFormState);
    setCreateModalOpen(true);
  };

  const handleOpenEdit = (group: GroupData) => {
    setForm({
      name: group.name,
      accountAccess: group.accountAccess,
      dataScope: group.dataScope,
    });
    setEditGroup(group);
  };

  const handleError = (e: unknown) => {
    if (e instanceof HTTPError) {
      e.response
        .json()
        .then((res: any) =>
          notifications.show({ color: 'red', message: res.message }),
        )
        .catch(() =>
          notifications.show({
            color: 'red',
            message: 'Something went wrong',
          }),
        );
    } else {
      notifications.show({ color: 'red', message: 'Something went wrong' });
    }
  };

  const handleCreate = () => {
    createGroup.mutate(
      {
        name: form.name,
        accountAccess: form.accountAccess,
        dataScope: form.dataScope,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Group created',
          });
          setCreateModalOpen(false);
          refetch();
        },
        onError: handleError,
      },
    );
  };

  const handleUpdate = () => {
    if (!editGroup) return;
    updateGroup.mutate(
      {
        id: editGroup._id,
        name: form.name,
        accountAccess: form.accountAccess,
        dataScope: form.dataScope,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Group updated',
          });
          setEditGroup(null);
          refetch();
        },
        onError: handleError,
      },
    );
  };

  const handleDelete = () => {
    if (!deleteConfirm) return;
    deleteGroup.mutate(
      { id: deleteConfirm._id },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Group deleted',
          });
          setDeleteConfirm(null);
          refetch();
        },
        onError: handleError,
      },
    );
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  };

  const formModal = (
    isEdit: boolean,
    opened: boolean,
    onClose: () => void,
    onSubmit: () => void,
    isLoading: boolean,
  ) => (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Text fw="bold" size="lg">
          {isEdit ? (
            <>
              Edit <strong>{editGroup?.name}</strong>
            </>
          ) : (
            'New Custom Group'
          )}
        </Text>
      }
      size="md"
    >
      <Stack gap="lg">
        <div>
          <Text fw="bold" mb={4}>
            Group Name
          </Text>
          <TextInput
            leftSection={<IconUsers size={16} />}
            placeholder="Staging Access"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.currentTarget.value })}
          />
        </div>

        <Divider label="Permissions" labelPosition="center" />

        <div>
          <Text fw="bold" mb={4}>
            Account Access
          </Text>
          <SegmentedControl
            fullWidth
            value={form.accountAccess}
            onChange={(v: string) =>
              setForm({
                ...form,
                accountAccess: v as 'read-only' | 'read-write',
              })
            }
            data={[
              {
                label: (
                  <Group gap={6} justify="center">
                    <IconLock size={14} /> Read-only
                  </Group>
                ),
                value: 'read-only',
              },
              {
                label: (
                  <Group gap={6} justify="center">
                    <IconLockOpen size={14} /> Read and Write
                  </Group>
                ),
                value: 'read-write',
              },
            ]}
          />
          {form.accountAccess === 'read-write' && (
            <Text size="sm" c="dimmed" mt={8}>
              Users assigned to this group will be able to create, update, and
              delete saved searches, dashboard, charts in this team.
            </Text>
          )}
        </div>

        <div>
          <Text fw="bold" mb={4}>
            Data Scope
          </Text>
          <TextInput
            leftSection={<IconFilter size={16} />}
            placeholder='service:staging'
            value={form.dataScope}
            onChange={e =>
              setForm({ ...form, dataScope: e.currentTarget.value })
            }
          />
          <Text size="sm" c="dimmed" mt={8}>
            After setting a data scope, users in this group will only be able to
            view <strong>Events</strong> data that matches the data scope.
          </Text>
        </div>

        <Group justify="center" mt="md">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={isLoading}
            disabled={!form.name.trim()}
          >
            {isEdit ? 'Save changes' : 'Create role'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return (
    <Box id="groups" data-testid="groups-section">
      <Text size="md">Groups</Text>
      <Divider my="md" />
      <Card>
        <Card.Section withBorder inheritPadding py="sm">
          <Group justify="space-between">
            <Text fw="bold">Groups</Text>
            <Button
              variant="primary"
              leftSection={<IconUsersPlus size={16} />}
              onClick={handleOpenCreate}
            >
              New Custom Group
            </Button>
          </Group>
        </Card.Section>
        <Card.Section>
          {groups.length === 0 ? (
            <Text c="dimmed" ta="center" py="xl">
              No groups created yet. Create a custom group to manage
              permissions.
            </Text>
          ) : (
            <Table horizontalSpacing="lg" verticalSpacing="xs">
              <Table.Tbody>
                {groups.map(group => (
                  <Table.Tr key={group._id}>
                    <Table.Td>
                      <Group gap="xs">
                        <IconUsers size={18} />
                        <Text fw="bold">{group.name}</Text>
                      </Group>
                      <Group mt={4} gap="xs">
                        <Badge
                          variant="light"
                          color={
                            group.accountAccess === 'read-write'
                              ? 'yellow'
                              : 'gray'
                          }
                          fw="normal"
                          tt="none"
                          leftSection={
                            group.accountAccess === 'read-write' ? (
                              <IconLockOpen size={12} />
                            ) : (
                              <IconLock size={12} />
                            )
                          }
                        >
                          {group.accountAccess === 'read-write'
                            ? 'Read and Write'
                            : 'Read-only'}
                        </Badge>
                        {group.dataScope && (
                          <Badge
                            variant="light"
                            color="blue"
                            fw="normal"
                            tt="none"
                            leftSection={<IconFilter size={12} />}
                          >
                            Data Scope
                          </Badge>
                        )}
                        <Text size="xs" c="dimmed">
                          Last edited {formatDate(group.updatedAt)}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Group gap="xs" justify="flex-end">
                        <Button
                          variant="outline"
                          color="red"
                          size="xs"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => setDeleteConfirm(group)}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          leftSection={<IconPencil size={14} />}
                          onClick={() => handleOpenEdit(group)}
                        >
                          Edit
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card.Section>
      </Card>

      {/* Create Modal */}
      {formModal(
        false,
        createModalOpen,
        () => setCreateModalOpen(false),
        handleCreate,
        createGroup.isPending,
      )}

      {/* Edit Modal */}
      {formModal(
        true,
        editGroup !== null,
        () => setEditGroup(null),
        handleUpdate,
        updateGroup.isPending,
      )}

      {/* Delete Confirmation */}
      <Modal
        opened={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Group"
        size="sm"
      >
        <Stack>
          <Text>
            Are you sure you want to delete the group{' '}
            <strong>{deleteConfirm?.name}</strong>? Users in this group will be
            unassigned.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleDelete}
              loading={deleteGroup.isPending}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
```

**Step 2: Commit**

```bash
git add packages/app/src/components/TeamSettings/GroupsSection.tsx
git commit -m "feat(app): add GroupsSection component with create/edit/delete modals"
```

---

### Task 7: Add GroupsSection to TeamPage

**Files:**
- Modify: `packages/app/src/TeamPage.tsx`

**Step 1: Import GroupsSection**

Add at the top with other TeamSettings imports:

```typescript
import GroupsSection from './components/TeamSettings/GroupsSection';
```

**Step 2: Add GroupsSection to the 'team' or 'access' tab**

Find the tab with value `'team'` or `'access'` and add `GroupsSection` to its `sections` array. It should appear in the `'access'` tab (alongside SecurityPoliciesSection), or as a new entry in the `'team'` tab above or below TeamMembersSection.

Based on the screenshots, add it to the `'team'` tab's sections (it appears alongside team members):

```typescript
{
  id: 'groups',
  content: <GroupsSection />,
},
```

**Step 3: Commit**

```bash
git add packages/app/src/TeamPage.tsx
git commit -m "feat(app): add GroupsSection to team settings page"
```

---

### Task 8: Add Group Assignment to Team Members

**Files:**
- Modify: `packages/app/src/components/TeamSettings/TeamMembersSection.tsx`

**Step 1: Add group assignment dropdown/select per member**

Import `api.useTeamGroups()` and `api.useAssignMemberGroup()`. For each member row, add a `Select` dropdown showing available groups. When changed, call the assign mutation.

Add to member imports:

```typescript
import { Select } from '@mantine/core';
```

In the component, add:

```typescript
const { data: groupsData } = api.useTeamGroups();
const assignGroup = api.useAssignMemberGroup();
const groups = groupsData?.data || [];
const groupOptions = [
  { value: '', label: 'No group' },
  ...groups.map((g: any) => ({ value: g._id, label: g.name })),
];
```

In each member row, add a `Select` component:

```tsx
<Select
  size="xs"
  data={groupOptions}
  value={member.groupId || ''}
  onChange={(value) => {
    assignGroup.mutate(
      { userId: member._id, groupId: value || null },
      {
        onSuccess: () => {
          refetch();
          notifications.show({ color: 'green', message: 'Group updated' });
        },
        onError: handleError,
      },
    );
  }}
  placeholder="Assign group"
  style={{ width: 160 }}
/>
```

**Step 2: Commit**

```bash
git add packages/app/src/components/TeamSettings/TeamMembersSection.tsx
git commit -m "feat(app): add group assignment dropdown to team members"
```

---

## Summary

| Task | Description | Est. Changes |
|------|-------------|-------------|
| 1 | Group Mongoose model | ~50 lines (new file) |
| 2 | Add groupId to User model | ~5 lines |
| 3 | Group Zod types in common-utils | ~20 lines |
| 4 | Group CRUD API routes + member assignment | ~150 lines |
| 5 | Frontend API hooks | ~50 lines |
| 6 | GroupsSection component | ~300 lines (new file) |
| 7 | Add GroupsSection to TeamPage | ~5 lines |
| 8 | Group assignment in TeamMembersSection | ~30 lines |

**Total code changes:** ~610 lines across 7 files (2 new, 5 modified)
