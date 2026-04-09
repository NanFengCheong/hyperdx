import express from 'express';
import { z } from 'zod';
import { processRequest } from 'zod-express-middleware';

import { validateChatId } from '@/services/telegram';

const router = express.Router();

// POST /telegram/validate - Validate a chat ID by sending a test message
router.post(
  '/validate',
  processRequest({
    body: z.object({
      chatId: z.string().min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (!teamId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const result = await validateChatId(teamId.toString(), req.body.chatId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
