import { findUserByEmail } from '@/controllers/user';
import { findUserByAccessKey } from '@/controllers/user';
import { getAgent, getLoggedInAgent, getServer } from '@/fixtures';
import User from '@/models/user';

const MOCK_USER = {
  email: 'fake@deploysentinel.com',
  password: 'TacoCat!2#4X',
};

describe('auth middleware - disabled user blocking', () => {
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

  it('should reject session-authenticated disabled user with 401', async () => {
    // Log in as a normal user
    const { agent, user } = await getLoggedInAgent(server);

    // Verify the user can access a protected route
    await agent.get('/team').expect(200);

    // Disable the user
    await User.findByIdAndUpdate(user._id, {
      disabledAt: new Date(),
      disabledReason: 'inactivity',
    });

    // The disabled user should get a generic 401
    const resp = await agent.get('/team');
    expect(resp.status).toBe(401);
    // Ensure no info leakage - body should not mention "disabled"
    expect(JSON.stringify(resp.body)).not.toContain('disabled');
    expect(JSON.stringify(resp.body)).not.toContain('Disabled');
  });

  it('should reject disabled user API key with 401', async () => {
    const { user } = await getLoggedInAgent(server);

    const accessKey = user.accessKey;

    // Verify API key works for active user
    const agent = getAgent(server);
    await agent
      .get('/api/v2')
      .set('Authorization', `Bearer ${accessKey}`)
      .expect(200);

    // Disable the user
    await User.findByIdAndUpdate(user._id, {
      disabledAt: new Date(),
      disabledReason: 'inactivity',
    });

    // API key should now be rejected
    await agent
      .get('/api/v2')
      .set('Authorization', `Bearer ${accessKey}`)
      .expect(401);
  });

  it('should allow active user to log in normally', async () => {
    const { agent } = await getLoggedInAgent(server);

    // Active user should be able to access protected routes
    await agent.get('/team').expect(200);
  });

  it('should update lastLoginAt on successful password login', async () => {
    const agent = getAgent(server);

    // Register user
    await agent
      .post('/register/password')
      .send({ ...MOCK_USER, confirmPassword: MOCK_USER.password })
      .expect(200);

    const userBefore = await findUserByEmail(MOCK_USER.email);
    const lastLoginBefore = userBefore?.lastLoginAt;

    // Wait a small amount to ensure timestamp differs
    await new Promise(resolve => setTimeout(resolve, 50));

    // Login
    await agent.post('/login/password').send(MOCK_USER).expect(302);

    const userAfter = await findUserByEmail(MOCK_USER.email);
    expect(userAfter?.lastLoginAt).toBeDefined();
    expect(userAfter!.lastLoginAt!.getTime()).toBeGreaterThan(
      lastLoginBefore!.getTime(),
    );
  });

  it('findUserByAccessKey should return null for disabled user', async () => {
    const { user } = await getLoggedInAgent(server);

    // Verify key works when active
    const foundUser = await findUserByAccessKey(user.accessKey);
    expect(foundUser).not.toBeNull();
    expect(foundUser!._id.toString()).toBe(user._id.toString());

    // Disable the user
    await User.findByIdAndUpdate(user._id, {
      disabledAt: new Date(),
      disabledReason: 'inactivity',
    });

    // Key should not resolve for disabled user
    const notFound = await findUserByAccessKey(user.accessKey);
    expect(notFound).toBeNull();
  });
});
