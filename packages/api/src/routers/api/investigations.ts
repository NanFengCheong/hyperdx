import type { Request } from 'express';
import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import { getAIModel } from '@/controllers/ai';
import { getConnectionById } from '@/controllers/connection';
import {
  addExport,
  appendMessage,
  createAlertInvestigation,
  createInvestigation,
  deleteInvestigation,
  getInvestigation,
  listInvestigations,
  updateInvestigation,
} from '@/controllers/investigation';
import {
  buildSystemPrompt,
  convertMessagesToAIFormat,
  runInvestigationAgent,
} from '@/controllers/investigation-agent';
import {
  buildSchemaPrompt,
  fetchClickHouseSchema,
} from '@/controllers/investigation-tools/schema';
import { getSource } from '@/controllers/sources';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import logger from '@/utils/logger';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

// POST /investigations - Create a new investigation
router.post(
  '/',
  validateRequest({
    body: z.object({
      title: z.string().min(1).max(200),
      entryPoint: z.object({
        type: z.enum(['trace', 'alert', 'standalone']),
        traceId: z.string().optional(),
        alertId: z.string().optional(),
      }),
      sourceId: objectIdSchema.optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId, userId } = getNonNullUserWithTeam(req);
      const { title, entryPoint, sourceId } = req.body;

      const investigation = await createInvestigation({
        teamId: teamId.toString(),
        userId: userId.toString(),
        title,
        entryPoint,
      });

      res.json(investigation);
    } catch (e) {
      next(e);
    }
  },
);

// POST /investigations/from-alert - Create investigation from alert with pre-filled message
router.post(
  '/from-alert',
  validateRequest({
    body: z.object({
      alertId: z.string().min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId, userId } = getNonNullUserWithTeam(req);
      const { alertId } = req.body;

      const investigation = await createAlertInvestigation({
        teamId: teamId.toString(),
        userId: userId.toString(),
        alertId,
      });

      res.json(investigation);
    } catch (e) {
      if ((e as Error).message === 'Alert not found') {
        return res.status(404).json({ error: 'Alert not found' });
      }
      next(e);
    }
  },
);

// GET /investigations - List investigations
router.get(
  '/',
  validateRequest({
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req as Request);
      const page = Number(req.query.page);
      const limit = Number(req.query.limit);

      const results = await listInvestigations({
        teamId: teamId.toString(),
        page,
        limit,
      });

      res.json(results);
    } catch (e) {
      next(e);
    }
  },
);

// GET /investigations/:id - Get a single investigation
router.get('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    const investigation = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });

    if (!investigation) {
      return res.status(404).json({ error: 'Investigation not found' });
    }

    res.json(investigation);
  } catch (e) {
    next(e);
  }
});

// POST /investigations/:id/messages - Send message & run agent loop (SSE)
router.post(
  '/:id/messages',
  validateRequest({
    body: z.object({
      content: z.string().min(1).max(10000),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { content, sourceId } = req.body;
      const investigationId = req.params.id;

      // Verify investigation exists
      const investigation = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      // Get ClickHouse connection
      const source = await getSource(teamId.toString(), sourceId);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }
      const connection = await getConnectionById(
        teamId.toString(),
        source.connection.toString(),
        true,
      );
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      // Append user message
      await appendMessage({
        teamId: teamId.toString(),
        investigationId,
        message: { role: 'user', content },
      });

      // Fetch schema for system prompt
      const schema = await fetchClickHouseSchema(
        teamId.toString(),
        source.connection.toString(),
      );
      const schemaPrompt = buildSchemaPrompt(schema);
      const systemPrompt = buildSystemPrompt({
        schemaPrompt,
        entryPoint: {
          type: investigation.entryPoint.type,
          traceId: investigation.entryPoint.traceId,
          alertId: investigation.entryPoint.alertId?.toString(),
        },
      });

      // Convert messages to AI format
      const allMessages = [
        ...convertMessagesToAIFormat(investigation.messages),
        { role: 'user' as const, content },
      ];

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const toolCalls: { name: string; args: unknown; result: unknown }[] = [];

      // Run agent
      const { text } = await runInvestigationAgent({
        messages: allMessages,
        systemPrompt,
        connection: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
        onTextDelta: delta => {
          res.write(
            `data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`,
          );
        },
        onToolCall: (toolName, args, result) => {
          toolCalls.push({ name: toolName, args, result });
          res.write(
            `data: ${JSON.stringify({ type: 'tool', name: toolName, args, result })}\n\n`,
          );
        },
        onFinish: () => {
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        },
      });

      // Persist assistant message
      await appendMessage({
        teamId: teamId.toString(),
        investigationId,
        message: {
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      });
    } catch (e) {
      // If SSE already started, send error event
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: (e as Error).message })}\n\n`,
        );
        res.end();
      } else {
        next(e);
      }
    }
  },
);

// PATCH /investigations/:id - Update investigation
router.patch(
  '/:id',
  validateRequest({
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'resolved', 'exported']).optional(),
      sharedWith: z.array(z.string()).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const updated = await updateInvestigation({
        teamId: teamId.toString(),
        investigationId: req.params.id,
        updates: req.body,
      });

      if (!updated) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

// DELETE /investigations/:id - Soft delete
router.delete('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    await deleteInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /investigations/:id/export - Generate incident report
router.post(
  '/:id/export',
  validateRequest({
    body: z.object({
      format: z.enum(['markdown', 'json']).default('markdown'),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { format, sourceId } = req.body;
      const investigationId = req.params.id;

      const investigation = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      if (format === 'json') {
        const result = await addExport({
          teamId: teamId.toString(),
          investigationId,
          exportData: {
            format: 'json',
            content: JSON.stringify(investigation, null, 2),
          },
        });
        return res.json(result);
      }

      // For markdown: ask AI to synthesize a report
      const source = await getSource(teamId.toString(), sourceId);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }
      const connection = await getConnectionById(
        teamId.toString(),
        source.connection.toString(),
        true,
      );
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const allMessages = convertMessagesToAIFormat(investigation.messages);
      allMessages.push({
        role: 'user' as const,
        content:
          'Please synthesize all findings from this investigation into a structured incident report in markdown format. Include sections: ## Summary, ## Timeline, ## Root Cause, ## Affected Services, ## Evidence, ## Recommendations.',
      });

      const { text } = await runInvestigationAgent({
        messages: allMessages,
        systemPrompt:
          'You are an incident report generator. Synthesize the investigation findings into a clear, structured incident report.',
        connection: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
      });

      const result = await addExport({
        teamId: teamId.toString(),
        investigationId,
        exportData: { format: 'markdown', content: text },
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// POST /investigations/:id/share - Share with team members
router.post(
  '/:id/share',
  validateRequest({
    body: z.object({
      userIds: z.array(z.string()).min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const updated = await updateInvestigation({
        teamId: teamId.toString(),
        investigationId: req.params.id,
        updates: { sharedWith: req.body.userIds },
      });

      if (!updated) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
