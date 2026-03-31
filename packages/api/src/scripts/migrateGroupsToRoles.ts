// Migration: Groups → Roles
//
// On app startup, call seedSystemRoles() after connectDB() completes.
// See packages/api/src/server.ts line 88 (await connectDB()) — add the
// seedSystemRoles() call right after that line, before the local-app-mode
// setup block.
//
// Example:
//   await connectDB();
//   await seedSystemRoles();  // ← add this

import mongoose from 'mongoose';
import Role from '../models/role';
import { SYSTEM_ROLES } from '@hyperdx/common-utils/dist/permissions';

async function seedSystemRoles() {
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const exists = await Role.findOne({
      teamId: null,
      name: def.name,
      isSystem: true,
    });
    if (!exists) {
      await Role.create({
        name: def.name,
        teamId: null,
        permissions: [...def.permissions],
        dataScopes: [...def.dataScopes],
        isSystem: true,
      });
      console.log(`Created system role: ${def.name}`);
    }
  }
}

async function migrateGroupsToRoles() {
  // 1. Seed system roles
  await seedSystemRoles();

  // 2. Get system roles for mapping
  const viewerRole = await Role.findOne({ name: 'Viewer', isSystem: true });
  const editorRole = await Role.findOne({ name: 'Editor', isSystem: true });

  if (!viewerRole || !editorRole) {
    throw new Error('System roles not found after seeding');
  }

  // 3. Convert existing custom groups to custom roles
  const Group = mongoose.model('Group');
  const groups = await Group.find();
  const groupToRoleMap = new Map<string, mongoose.Types.ObjectId>();

  for (const group of groups) {
    let role = await Role.findOne({ teamId: (group as any).teamId, name: (group as any).name });
    if (!role) {
      role = await Role.create({
        name: (group as any).name,
        teamId: (group as any).teamId,
        permissions: (group as any).accountAccess === 'read-write'
          ? [...SYSTEM_ROLES.EDITOR.permissions]
          : [...SYSTEM_ROLES.VIEWER.permissions],
        dataScopes: (group as any).dataScope ? [(group as any).dataScope] : [],
        isSystem: false,
      });
      console.log(`Migrated group "${(group as any).name}" to role`);
    }
    groupToRoleMap.set((group as any)._id.toString(), role._id);
  }

  // 4. Update users: groupId → roleId
  const User = mongoose.model('User');
  const usersWithGroups = await User.find({ groupId: { $exists: true, $ne: null } });

  for (const user of usersWithGroups) {
    const roleId = groupToRoleMap.get((user as any).groupId.toString());
    if (roleId) {
      await User.updateOne(
        { _id: (user as any)._id },
        { $set: { roleId }, $unset: { groupId: 1 } },
      );
      console.log(`Migrated user ${(user as any).email}: groupId → roleId`);
    }
  }

  // 5. Users without groups get Viewer role
  const usersWithoutRole = await User.find({
    roleId: { $exists: false },
    groupId: { $exists: false },
  });
  for (const user of usersWithoutRole) {
    await User.updateOne(
      { _id: (user as any)._id },
      { $set: { roleId: viewerRole._id } },
    );
    console.log(`Assigned Viewer role to ${(user as any).email}`);
  }

  console.log('Migration complete');
}

/**
 * Ensure the default super admin exists based on DEFAULT_SUPER_ADMIN_EMAIL env var.
 * Idempotent — only promotes if user exists and isn't already super admin.
 */
async function ensureDefaultSuperAdmin() {
  const email = process.env.DEFAULT_SUPER_ADMIN_EMAIL;
  if (!email) return;

  const User = mongoose.model('User');
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.log(`DEFAULT_SUPER_ADMIN_EMAIL: user "${email}" not found, skipping`);
    return;
  }

  if ((user as any).isSuperAdmin) {
    console.log(`DEFAULT_SUPER_ADMIN_EMAIL: "${email}" is already super admin`);
    return;
  }

  await User.updateOne(
    { _id: (user as any)._id },
    { $set: { isSuperAdmin: true } },
  );
  console.log(`DEFAULT_SUPER_ADMIN_EMAIL: promoted "${email}" to super admin`);
}

export { migrateGroupsToRoles, seedSystemRoles, ensureDefaultSuperAdmin };
