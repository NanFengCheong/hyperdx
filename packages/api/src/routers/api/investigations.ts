import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import { buildReplayEventSequence } from '@/controllers/buildReplayEventSequence';
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
import { updateInvestigation as updateInv } from '@/controllers/investigation';
import {
  buildSystemPrompt,
  convertMessagesToAIFormat,
  runInvestigationAgent,
  runInvestigationCycle,
} from '@/controllers/investigation-agent';
import {
  buildSchemaPrompt,
  fetchClickHouseSchema,
} from '@/controllers/investigation-tools/schema';
import { getSource } from '@/controllers/sources';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import type { LoopPhase } from '@/models/investigation';
import Investigation from '@/models/investigation';
import type { DebugEvent } from '@/utils/investigationEventBus';
import { investigationEventBus } from '@/utils/investigationEventBus';
import logger from '@/utils/logger';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

// POST /investigations — Create a new investigation
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
      const { teamId, userId } = getNonNullUserWithTeam(req as any);
      const { title, entryPoint } = req.body;

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

// GET /investigations — List investigations
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
      const { teamId } = getNonNullUserWithTeam(req as any);
      const { page, limit } = req.query;

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

// GET /investigations/:id — Get a single investigation
router.get('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req as any);
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

// POST /investigations/:id/messages — Send message & run agent loop (SSE)
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
      const { teamId, userId } = getNonNullUserWithTeam(req as any);
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
        entryPoint: investigation.entryPoint,
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
        teamId: teamId.toString(),
        userId: userId.toString(),
        onTextDelta: delta => {
          res.write(
            `data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`,
          );
        },
        onToolCall: (toolName, args, result) => {
          toolCalls.push({ name: toolName, args, result });
          res.write(
            `data: ${JSON.stringify({
              type: 'tool',
              name: toolName,
              args,
              result,
            })}\n\n`,
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
          `data: ${JSON.stringify({
            type: 'error',
            message: (e as Error).message,
          })}\n\n`,
        );
        res.end();
      } else {
        next(e);
      }
    }
  },
);

// PATCH /investigations/:id — Update investigation
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
      const { teamId } = getNonNullUserWithTeam(req as any);
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

// DELETE /investigations/:id — Soft delete
router.delete('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req as any);
    await deleteInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /investigations/:id/export — Generate incident report
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
      const { teamId, userId } = getNonNullUserWithTeam(req as any);
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
        role: 'user',
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
        teamId: teamId.toString(),
        userId: userId.toString(),
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

// POST /investigations/:id/share — Share with team members
router.post(
  '/:id/share',
  validateRequest({
    body: z.object({
      userIds: z.array(z.string()).min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req as any);
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

// GET /investigations/:id/loop-state — Get the current loop state of an investigation
router.get('/:id/loop-state', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req as any);
    const investigation = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });

    if (!investigation) {
      return res.status(404).json({ error: 'Investigation not found' });
    }

    res.json({
      loopState: investigation.loopState || null,
      status: investigation.status,
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /investigations/:id/summary — Update investigation summary
router.patch(
  '/:id/summary',
  validateRequest({
    body: z.object({
      summary: z.string().min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req as any);
      const updated = await updateInvestigation({
        teamId: teamId.toString(),
        investigationId: req.params.id,
        updates: { summary: req.body.summary },
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

// POST /investigations/from-alert — Create investigation from an alert
router.post(
  '/from-alert',
  validateRequest({
    body: z.object({
      alertId: z.string().min(1),
      sourceId: objectIdSchema.optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId, userId } = getNonNullUserWithTeam(req as any);
      const { alertId } = req.body;

      const investigation = await createAlertInvestigation({
        teamId: teamId.toString(),
        userId: userId.toString(),
        alertId,
      });

      res.status(201).json(investigation);
    } catch (e) {
      if ((e as Error).message === 'Alert not found') {
        return res.status(404).json({ error: 'Alert not found' });
      }
      next(e);
    }
  },
);

// POST /investigations/:id/run-cycle — Trigger a multi-phase investigation cycle via SSE
router.post(
  '/:id/run-cycle',
  validateRequest({
    body: z.object({
      triggerDescription: z.string().min(1).max(500),
      triggerType: z
        .enum(['health_scan', 'alert', 'trend_review', 'standalone'])
        .default('standalone'),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId, userId } = getNonNullUserWithTeam(req as any);
      const { triggerDescription, triggerType, sourceId } = req.body;
      const investigationId = req.params.id;

      const investigation = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

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

      const schema = await fetchClickHouseSchema(
        teamId.toString(),
        source.connection.toString(),
      );
      const schemaPrompt = buildSchemaPrompt(schema);

      // SSE setup
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const result = await runInvestigationCycle({
        triggerDescription,
        triggerType: triggerType ?? 'standalone',
        schemaPrompt,
        memoryContext: '',
        connection: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
        teamId: teamId.toString(),
        userId: userId.toString(),
        investigationId,
        onPhaseUpdate: (phase, output) => {
          res.write(
            `data: ${JSON.stringify({
              type: 'phase',
              phase,
              output,
            })}\n\n`,
          );
        },
      });

      // Save the results
      await updateInv({
        teamId: teamId.toString(),
        investigationId,
        updates: {
          summary: result.summary,
          status: result.confidence === 'high' ? 'resolved' : 'active',
        },
      });

      // Persist toolCallLog and thinkingLog to loopState
      if (result.toolCallLog.length > 0 || result.thinkingLog.length > 0) {
        await Investigation.findByIdAndUpdate(investigationId, {
          $set: {
            'loopState.toolCallLog': result.toolCallLog,
            'loopState.thinkingLog': result.thinkingLog,
          },
        });
      }

      res.write(
        `data: ${JSON.stringify({
          type: 'complete',
          confidence: result.confidence,
          summary: result.summary,
        })}\n\n`,
      );
      res.end();
    } catch (e) {
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: (e as Error).message,
          })}\n\n`,
        );
        res.end();
      } else {
        next(e);
      }
    }
  },
);

// GET /investigations/:id/stream — SSE debug stream for an investigation
router.get('/:id/stream', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req as any);
    // No teamRole in codebase — default isOwner to false (thinking events filtered for non-owners)
    const isOwner = false;
    const investigationId = req.params.id;
    const speed = Number(req.query.speed) || 1;
    const startPhase = req.query.startPhase as LoopPhase | undefined;
    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = lastEventIdHeader
      ? Number(lastEventIdHeader)
      : undefined;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let eventId = lastEventId ?? 0;
    let closed = false;
    let lastEventTime = Date.now();

    req.on('close', () => {
      closed = true;
    });

    const sendEvent = (event: DebugEvent) => {
      if (closed) return;
      // Strip thinking events for non-owners
      if (event.type === 'thinking' && !isOwner) return;
      lastEventTime = Date.now();
      eventId++;
      res.write(`id: ${eventId}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Fetch investigation
    let investigation = await getInvestigation({
      teamId: teamId.toString(),
      investigationId,
    });
    if (!investigation) {
      res.write(
        `data: ${JSON.stringify({ type: 'investigation_failed', investigationId, error: 'Investigation not found', timestamp: Date.now() })}\n\n`,
      );
      res.end();
      return;
    }

    logger.info(`[stream] opened investigationId=${investigationId}`);

    // --- WAITING STATE (Phase 6) ---
    if (
      investigation.status === 'active' &&
      !investigation.loopState?.currentPhase
    ) {
      let polls = 0;
      const MAX_POLLS = 10;
      while (polls < MAX_POLLS && !closed) {
        res.write(
          `data: ${JSON.stringify({ type: 'waiting', investigationId, timestamp: Date.now() })}\n\n`,
        );
        await new Promise(r => setTimeout(r, 2000));
        investigation = await getInvestigation({
          teamId: teamId.toString(),
          investigationId,
        });
        if (!investigation || investigation.loopState?.currentPhase) break;
        polls++;
      }
      if (polls >= MAX_POLLS || !investigation) {
        res.write(
          `data: ${JSON.stringify({ type: 'investigation_failed', investigationId, error: 'Investigation did not start in time', timestamp: Date.now() })}\n\n`,
        );
        res.end();
        return;
      }
    }

    // --- REPLAY MODE (terminal investigation) ---
    const isTerminal =
      investigation.status === 'resolved' ||
      investigation.status === 'exported' ||
      investigation.loopState?.currentPhase === 'complete';

    if (isTerminal) {
      const fullInv = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!fullInv) {
        res.end();
        return;
      }

      const replayEvents = buildReplayEventSequence(fullInv, {
        isOwner,
        startPhase,
        lastEventId,
      });
      const delayMs = speed >= 10 ? 8 : speed >= 5 ? 16 : 80;

      res.write(
        `data: ${JSON.stringify({ type: 'replay_start', investigationId, timestamp: Date.now() })}\n\n`,
      );

      for (const event of replayEvents) {
        if (closed) break;
        sendEvent(event);
        await new Promise(r => setTimeout(r, delayMs));
      }

      if (!closed) {
        res.write(
          `data: ${JSON.stringify({ type: 'replay_complete', investigationId, timestamp: Date.now() })}\n\n`,
        );
        res.end();
      }

      logger.info(`[stream] closed investigationId=${investigationId}`);
      return;
    }

    // --- LIVE MODE ---
    // Replay missed events from toolCallLog on reconnect (Last-Event-ID)
    if (lastEventId !== undefined && investigation.loopState?.toolCallLog) {
      const missed = investigation.loopState.toolCallLog.filter(
        tc => tc.callIndex > lastEventId - 1,
      );
      for (const tc of missed) {
        sendEvent({
          type: 'tool_call',
          investigationId,
          callIndex: tc.callIndex,
          phase: tc.phase,
          tool: tc.tool,
          args: tc.args,
          timestamp: Date.now(),
        });
        if (tc.error) {
          sendEvent({
            type: 'tool_error',
            investigationId,
            callIndex: tc.callIndex,
            phase: tc.phase,
            tool: tc.tool,
            error: tc.error,
            durationMs: tc.durationMs ?? 0,
            timestamp: Date.now(),
          });
        } else if (tc.result !== undefined) {
          sendEvent({
            type: 'tool_result',
            investigationId,
            callIndex: tc.callIndex,
            phase: tc.phase,
            tool: tc.tool,
            result: tc.result,
            durationMs: tc.durationMs ?? 0,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Subscribe to live events
    const unsubscribe = investigationEventBus.subscribeToInvestigation(
      investigationId,
      sendEvent,
    );

    // Send connected ping
    res.write(
      `data: ${JSON.stringify({ type: 'connected', investigationId })}\n\n`,
    );

    // 30s runner timeout guard (Phase 6)
    const timeoutInterval = setInterval(() => {
      if (closed) {
        clearInterval(timeoutInterval);
        return;
      }
      if (Date.now() - lastEventTime > 30000) {
        clearInterval(timeoutInterval);
        sendEvent({
          type: 'investigation_failed',
          investigationId,
          error: 'runner_timeout',
          timestamp: Date.now(),
        });
        res.end();
      }
    }, 5000);

    req.on('close', () => {
      closed = true;
      unsubscribe();
      clearInterval(timeoutInterval);
      logger.info(`[stream] closed investigationId=${investigationId}`);
    });
  } catch (e) {
    next(e);
  }
});

export default router;
