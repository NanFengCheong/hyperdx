import { clearDBCollections, closeDB, connectDB } from '@/fixtures';
import User from '@/models/user';

describe('User model', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDBCollections();
  });

  afterAll(async () => {
    await closeDB();
  });

  it('sets lastLoginAt to current date on creation', async () => {
    const before = new Date();
    const user = new User({ email: 'test@example.com' });
    await user.save();
    const after = new Date();

    expect(user.lastLoginAt).toBeInstanceOf(Date);
    expect(user.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(user.lastLoginAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('defaults disabledAt to null', async () => {
    const user = new User({ email: 'test@example.com' });
    await user.save();

    expect(user.disabledAt).toBeNull();
  });

  it('defaults disabledReason to null', async () => {
    const user = new User({ email: 'test@example.com' });
    await user.save();

    expect(user.disabledReason).toBeNull();
  });

  it('accepts explicit values for disable fields', async () => {
    const now = new Date();
    const user = new User({
      email: 'disabled@example.com',
      disabledAt: now,
      disabledReason: 'Inactive for 90 days',
    });
    await user.save();

    expect(user.disabledAt).toEqual(now);
    expect(user.disabledReason).toBe('Inactive for 90 days');
  });
});
