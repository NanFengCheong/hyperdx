import { clearDBCollections, closeDB, connectDB } from '@/fixtures';
import User from '@/models/user';
import { disableInactiveUsers } from '@/tasks/checkInactiveUsers';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('disableInactiveUsers', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDBCollections();
  });

  afterAll(async () => {
    await closeDB();
  });

  it('disables a user inactive for more than 90 days', async () => {
    await User.create({
      email: 'old@example.com',
      lastLoginAt: new Date(Date.now() - 91 * DAY_MS),
    });

    const count = await disableInactiveUsers();

    expect(count).toBe(1);
    const user = await User.findOne({ email: 'old@example.com' });
    expect(user!.disabledAt).toBeInstanceOf(Date);
    expect(user!.disabledReason).toBe('inactivity_90d');
  });

  it('does NOT disable a user who logged in within 90 days', async () => {
    await User.create({
      email: 'recent@example.com',
      lastLoginAt: new Date(Date.now() - 30 * DAY_MS),
    });

    const count = await disableInactiveUsers();

    expect(count).toBe(0);
    const user = await User.findOne({ email: 'recent@example.com' });
    expect(user!.disabledAt).toBeNull();
  });

  it('does NOT disable super admins even if inactive >90 days', async () => {
    await User.create({
      email: 'admin@example.com',
      lastLoginAt: new Date(Date.now() - 200 * DAY_MS),
      isSuperAdmin: true,
    });

    const count = await disableInactiveUsers();

    expect(count).toBe(0);
    const user = await User.findOne({ email: 'admin@example.com' });
    expect(user!.disabledAt).toBeNull();
  });

  it('does NOT re-disable already disabled users', async () => {
    const originalDisabledAt = new Date(Date.now() - 10 * DAY_MS);
    await User.create({
      email: 'already-disabled@example.com',
      lastLoginAt: new Date(Date.now() - 120 * DAY_MS),
      disabledAt: originalDisabledAt,
      disabledReason: 'manual',
    });

    const count = await disableInactiveUsers();

    expect(count).toBe(0);
    const user = await User.findOne({ email: 'already-disabled@example.com' });
    expect(user!.disabledAt!.getTime()).toBe(originalDisabledAt.getTime());
    expect(user!.disabledReason).toBe('manual');
  });

  it('handles the 90-day boundary correctly', async () => {
    // 89 days ago — safely within the active window, should NOT be disabled
    await User.create({
      email: 'boundary-safe@example.com',
      lastLoginAt: new Date(Date.now() - 89 * DAY_MS),
    });
    // 91 days ago — clearly past the cutoff, should be disabled
    await User.create({
      email: 'just-over@example.com',
      lastLoginAt: new Date(Date.now() - 91 * DAY_MS),
    });

    const count = await disableInactiveUsers();

    expect(count).toBe(1);

    const safeUser = await User.findOne({ email: 'boundary-safe@example.com' });
    expect(safeUser!.disabledAt).toBeNull();

    const overUser = await User.findOne({ email: 'just-over@example.com' });
    expect(overUser!.disabledAt).toBeInstanceOf(Date);
    expect(overUser!.disabledReason).toBe('inactivity_90d');
  });
});
