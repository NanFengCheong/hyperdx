import { getLoggedInAgent, getServer } from '@/fixtures';
import User from '@/models/user';
import { disableInactiveUsers } from '@/tasks/checkInactiveUsers';

describe('inactive user auto-disable full flow', () => {
  const server = getServer();

  beforeAll(async () => {
    await server.start();
  });

  afterEach(async () => {
    await server.clearDBs();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('full lifecycle: login → inactivity → disable → reactivate', async () => {
    const { agent, team } = await getLoggedInAgent(server);

    // Create a regular user with a recent login
    const targetUser = await User.create({
      email: 'lifecycle@example.com',
      team: team.id,
      lastLoginAt: new Date(),
    });

    // Simulate 91 days of inactivity
    const ninetyOneDaysAgo = new Date(
      Date.now() - 91 * 24 * 60 * 60 * 1000,
    );
    await User.findByIdAndUpdate(targetUser._id, {
      lastLoginAt: ninetyOneDaysAgo,
    });

    // Run the cron task — should disable the inactive user
    const disabledCount = await disableInactiveUsers();
    expect(disabledCount).toBeGreaterThanOrEqual(1);

    // Verify user is disabled
    const disabledUser = await User.findById(targetUser._id);
    expect(disabledUser?.disabledAt).not.toBeNull();
    expect(disabledUser?.disabledReason).toBe('inactivity_90d');

    // Verify the user appears disabled in GET /team/members
    const membersResp = await agent.get('/team/members').expect(200);
    const disabledMember = membersResp.body.data.find(
      (m: any) => m.email === 'lifecycle@example.com',
    );
    expect(disabledMember).toBeDefined();
    expect(disabledMember.disabledAt).not.toBeNull();
    expect(disabledMember.disabledReason).toBe('inactivity_90d');

    // Reactivate via API
    const beforeReactivation = new Date();
    await agent
      .patch(`/team/member/${targetUser._id}/reactivate`)
      .expect(200);

    // Verify user fields are reset
    const reactivatedUser = await User.findById(targetUser._id);
    expect(reactivatedUser?.disabledAt).toBeNull();
    expect(reactivatedUser?.disabledReason).toBeNull();
    expect(reactivatedUser?.lastLoginAt).not.toBeNull();
    expect(reactivatedUser!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(
      beforeReactivation.getTime(),
    );

    // Verify the user appears active in GET /team/members after reactivation
    const membersResp2 = await agent.get('/team/members').expect(200);
    const reactivatedMember = membersResp2.body.data.find(
      (m: any) => m.email === 'lifecycle@example.com',
    );
    expect(reactivatedMember.disabledAt).toBeNull();
    expect(reactivatedMember.disabledReason).toBeNull();
  });

  it('super admin is immune to auto-disable', async () => {
    const { team } = await getLoggedInAgent(server);

    // Create a super admin user inactive for 120 days
    const oneHundredTwentyDaysAgo = new Date(
      Date.now() - 120 * 24 * 60 * 60 * 1000,
    );
    const superAdmin = await User.create({
      email: 'superadmin@example.com',
      team: team.id,
      lastLoginAt: oneHundredTwentyDaysAgo,
      isSuperAdmin: true,
    });

    // Run the cron task
    await disableInactiveUsers();

    // Super admin should NOT be disabled
    const superAdminAfter = await User.findById(superAdmin._id);
    expect(superAdminAfter?.disabledAt).toBeNull();
    expect(superAdminAfter?.disabledReason).toBeNull();
  });

  it('does not disable users who logged in within 90 days', async () => {
    const { team } = await getLoggedInAgent(server);

    // Create a user who logged in 30 days ago (well within threshold)
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    );
    const activeUser = await User.create({
      email: 'active-user@example.com',
      team: team.id,
      lastLoginAt: thirtyDaysAgo,
    });

    await disableInactiveUsers();

    const userAfter = await User.findById(activeUser._id);
    expect(userAfter?.disabledAt).toBeNull();
    expect(userAfter?.disabledReason).toBeNull();
  });

  it('does not re-disable an already disabled user', async () => {
    const { team } = await getLoggedInAgent(server);

    const originalDisabledAt = new Date('2026-01-01');
    await User.create({
      email: 'already-disabled@example.com',
      team: team.id,
      lastLoginAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      disabledAt: originalDisabledAt,
      disabledReason: 'inactivity_90d',
    });

    // Running again should not modify the already-disabled user
    const count = await disableInactiveUsers();
    // The logged-in agent user (fake@deploysentinel.com) just logged in,
    // so count should be 0 (no new users to disable)
    expect(count).toBe(0);
  });
});
