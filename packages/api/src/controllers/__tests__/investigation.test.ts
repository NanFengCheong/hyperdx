import mongoose from 'mongoose';

import {
  addExport,
  appendMessage,
  createInvestigation,
  deleteInvestigation,
  getInvestigation,
  listInvestigations,
  updateInvestigation,
} from '../investigation';

describe('Investigation controller', () => {
  let teamId: mongoose.Types.ObjectId;
  let userId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    await mongoose.connect(
      process.env.MONGO_URI || 'mongodb://localhost:27017/hyperdx-test',
    );
    teamId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  it('should create an investigation', async () => {
    const result = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Test',
      entryPoint: { type: 'standalone' as const },
    });
    expect(result._id).toBeDefined();
    expect(result.status).toBe('active');
  });

  it('should list investigations for a team', async () => {
    const results = await listInvestigations({
      teamId: teamId.toString(),
      page: 1,
      limit: 10,
    });
    expect(results.data.length).toBeGreaterThan(0);
    expect(results.total).toBeGreaterThan(0);
  });

  it('should get a single investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Get test',
      entryPoint: { type: 'trace' as const, traceId: 'xyz' },
    });
    const result = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Get test');
  });

  it('should update an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Update test',
      entryPoint: { type: 'standalone' as const },
    });
    const updated = await updateInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
      updates: { title: 'Updated title', status: 'resolved' },
    });
    expect(updated!.title).toBe('Updated title');
    expect(updated!.status).toBe('resolved');
  });

  it('should soft-delete an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Delete test',
      entryPoint: { type: 'standalone' as const },
    });
    await deleteInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    const result = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    expect(result).toBeNull();
  });

  it('should append a message to an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Message test',
      entryPoint: { type: 'standalone' as const },
    });
    const updated = await appendMessage({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
      message: {
        role: 'user',
        content: 'Hello',
      },
    });
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0].content).toBe('Hello');
    expect(updated!.messages[0].role).toBe('user');
  });

  it('should append a tool message with toolCalls', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Tool message test',
      entryPoint: { type: 'standalone' as const },
    });
    const updated = await appendMessage({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
      message: {
        role: 'tool',
        content: 'Tool result',
        toolCalls: [
          {
            name: 'query_logs',
            args: { service: 'api' },
            result: { count: 42 },
          },
        ],
      },
    });
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0].toolCalls).toHaveLength(1);
    expect(updated!.messages[0].toolCalls![0].name).toBe('query_logs');
  });

  it('should add an export to an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Export test',
      entryPoint: { type: 'standalone' as const },
    });
    const updated = await addExport({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
      exportData: { format: 'markdown', content: '# Summary' },
    });
    expect(updated!.exports).toHaveLength(1);
    expect(updated!.exports![0].content).toBe('# Summary');
    expect(updated!.status).toBe('exported');
  });
});
