import mongoose from 'mongoose';

import { clearDBCollections, closeDB, connectDB } from '@/fixtures';
import User from '@/models/user';
import { backfillLastLoginAt } from '@/tasks/checkInactiveUsersBackfill';

describe('backfillLastLoginAt', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDBCollections();
  });

  afterAll(async () => {
    await closeDB();
  });

  it('sets lastLoginAt to updatedAt for users without it', async () => {
    const updatedAt = new Date('2025-06-15T00:00:00Z');

    // Insert directly to bypass Mongoose schema defaults
    const col = mongoose.connection.db.collection('users');
    const { insertedId } = await col.insertOne({
      email: 'legacy@example.com',
      updatedAt,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    const count = await backfillLastLoginAt();

    expect(count).toBe(1);

    const doc = await col.findOne({ _id: insertedId });
    expect(doc!.lastLoginAt).toEqual(updatedAt);
  });

  it('does NOT overwrite existing lastLoginAt values', async () => {
    const existingLogin = new Date('2026-01-01T00:00:00Z');

    // User created via Mongoose will have lastLoginAt set by default
    const user = new User({
      email: 'active@example.com',
      lastLoginAt: existingLogin,
    });
    await user.save();

    const count = await backfillLastLoginAt();

    expect(count).toBe(0);

    const refreshed = await User.findById(user._id);
    expect(refreshed!.lastLoginAt!.getTime()).toBe(existingLogin.getTime());
  });

  it('sets disabledAt and disabledReason to null', async () => {
    const col = mongoose.connection.db.collection('users');
    const { insertedId } = await col.insertOne({
      email: 'old@example.com',
      updatedAt: new Date('2025-03-01T00:00:00Z'),
      createdAt: new Date('2025-01-01T00:00:00Z'),
      // no lastLoginAt, no disabledAt/disabledReason
    });

    await backfillLastLoginAt();

    const doc = await col.findOne({ _id: insertedId });
    expect(doc!.disabledAt).toBeNull();
    expect(doc!.disabledReason).toBeNull();
  });

  it('handles multiple users, only updating those without lastLoginAt', async () => {
    const col = mongoose.connection.db.collection('users');

    // Legacy user without lastLoginAt
    await col.insertOne({
      email: 'legacy1@example.com',
      updatedAt: new Date('2025-05-01T00:00:00Z'),
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });

    await col.insertOne({
      email: 'legacy2@example.com',
      updatedAt: new Date('2025-07-01T00:00:00Z'),
      createdAt: new Date('2025-02-01T00:00:00Z'),
    });

    // Modern user with lastLoginAt
    const modernUser = new User({
      email: 'modern@example.com',
      lastLoginAt: new Date('2026-03-01T00:00:00Z'),
    });
    await modernUser.save();

    const count = await backfillLastLoginAt();

    expect(count).toBe(2);

    // Verify modern user was untouched
    const refreshed = await User.findById(modernUser._id);
    expect(refreshed!.lastLoginAt!.getTime()).toBe(
      new Date('2026-03-01T00:00:00Z').getTime(),
    );
  });

  it('returns 0 when no users need backfilling', async () => {
    const count = await backfillLastLoginAt();
    expect(count).toBe(0);
  });
});
