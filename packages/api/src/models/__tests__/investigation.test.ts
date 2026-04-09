import mongoose from 'mongoose';

import { clearDBCollections, closeDB, connectDB } from '@/fixtures';

import Investigation from '../investigation';

describe('Investigation model', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDBCollections();
  });

  afterAll(async () => {
    await closeDB();
  });

  it('should create an investigation with required fields', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Test investigation',
      status: 'active',
      entryPoint: { type: 'standalone' },
      messages: [],
    });

    expect(investigation._id).toBeDefined();
    expect(investigation.team.toString()).toBe(teamId.toString());
    expect(investigation.status).toBe('active');
    expect(investigation.messages).toHaveLength(0);
  });

  it('should store messages with tool calls', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Trace investigation',
      status: 'active',
      entryPoint: { type: 'trace', traceId: 'abc123' },
      messages: [
        {
          role: 'user',
          content: 'Why did this trace fail?',
          timestamp: new Date(),
        },
        {
          role: 'assistant',
          content: 'The trace failed due to a timeout.',
          toolCalls: [
            {
              name: 'getTraceDetail',
              args: { traceId: 'abc123' },
              result: { spans: [] },
            },
          ],
          timestamp: new Date(),
        },
      ],
    });

    expect(investigation.messages).toHaveLength(2);
    expect(investigation.messages[1].toolCalls).toHaveLength(1);
    expect(investigation.messages[1].toolCalls![0].name).toBe('getTraceDetail');
  });

  it('should store exports', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Exported investigation',
      status: 'exported',
      entryPoint: { type: 'standalone' },
      messages: [],
      exports: [
        {
          format: 'markdown',
          content: '# Incident Report\n\nSummary here.',
          createdAt: new Date(),
        },
      ],
    });

    expect(investigation.exports).toHaveLength(1);
    expect(investigation.exports![0].format).toBe('markdown');
  });
});
