import compression from 'compression';
import MongoStore from 'connect-mongo';
import express from 'express';
import session from 'express-session';
import onHeaders from 'on-headers';

import * as config from './config';
import { isUserAuthenticated, requireWriteAccess } from './middleware/auth';
import defaultCors from './middleware/cors';
import { appErrorHandler } from './middleware/error';
import Team from './models/team';
import routers from './routers/api';
import clickhouseProxyRouter from './routers/api/clickhouseProxy';
import connectionsRouter from './routers/api/connections';
import favoritesRouter from './routers/api/favorites';
import investigationsRouter from './routers/api/investigations';
import savedSearchRouter from './routers/api/savedSearch';
import sourcesRouter from './routers/api/sources';
import externalRoutersV2 from './routers/external-api/v2';
import { handleCallback } from './services/telegram';
import usageStats from './tasks/usageStats';
import logger, { expressLogger } from './utils/logger';
import passport from './utils/passport';

const app: express.Application = express();

const sess: session.SessionOptions & { cookie: session.CookieOptions } = {
  // Use a slot-specific cookie name in dev so multiple worktrees on localhost
  // don't overwrite each other's session cookies.
  ...(config.IS_DEV && process.env.HDX_DEV_SLOT
    ? { name: `connect.sid.${process.env.HDX_DEV_SLOT}` }
    : {}),
  resave: false,
  saveUninitialized: false,
  secret: config.EXPRESS_SESSION_SECRET,
  cookie: {
    secure: false,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
  rolling: true,
  store: new MongoStore({ mongoUrl: config.MONGO_URI }),
};

app.set('trust proxy', 1);
if (!config.IS_CI && config.FRONTEND_URL) {
  const feUrl = new URL(config.FRONTEND_URL);
  sess.cookie.domain = feUrl.hostname;
  if (feUrl.protocol === 'https:') {
    sess.cookie.secure = true;
  }
}

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '32mb' }));
app.use(express.text({ limit: '32mb' }));
app.use(express.urlencoded({ extended: false, limit: '32mb' }));
app.use(session(sess));

if (!config.IS_LOCAL_APP_MODE) {
  app.use(passport.initialize());
  app.use(passport.session());
}

if (!config.IS_CI) {
  app.use(expressLogger);
}
// Allows timing data from frontend package
// see: https://github.com/expressjs/cors/issues/102
app.use(function (req, res, next) {
  onHeaders(res, function () {
    const allowOrigin = res.getHeader('Access-Control-Allow-Origin');
    if (allowOrigin) {
      res.setHeader('Timing-Allow-Origin', allowOrigin);
    }
  });
  next();
});
app.use(defaultCors);

// ---------------------------------------------------------------------
// ----------------------- Background Jobs -----------------------------
// ---------------------------------------------------------------------
if (config.USAGE_STATS_ENABLED) {
  usageStats();
}
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// ----------------------- Internal Routers ----------------------------
// ---------------------------------------------------------------------
// PUBLIC ROUTES
app.use('/', routers.rootRouter);

// PRIVATE ROUTES
app.use('/admin', routers.adminRouter);
app.use('/ai', isUserAuthenticated, routers.aiRouter);
app.use(
  '/alerts',
  isUserAuthenticated,
  requireWriteAccess,
  routers.alertsRouter,
);
app.use(
  '/dashboards',
  isUserAuthenticated,
  requireWriteAccess,
  routers.dashboardRouter,
);
app.use('/me', isUserAuthenticated, routers.meRouter);
app.use('/team', isUserAuthenticated, requireWriteAccess, routers.teamRouter);
app.use(
  '/webhooks',
  isUserAuthenticated,
  requireWriteAccess,
  routers.webhooksRouter,
);
app.use(
  '/connections',
  isUserAuthenticated,
  requireWriteAccess,
  connectionsRouter,
);
app.use('/sources', isUserAuthenticated, requireWriteAccess, sourcesRouter);
app.use(
  '/saved-search',
  isUserAuthenticated,
  requireWriteAccess,
  savedSearchRouter,
);
app.use('/favorites', isUserAuthenticated, requireWriteAccess, favoritesRouter);
app.use('/clickhouse-proxy', isUserAuthenticated, clickhouseProxyRouter);
app.use(
  '/investigations',
  isUserAuthenticated,
  requireWriteAccess,
  investigationsRouter,
);

// Telegram: callback is public (called by Telegram servers), validate requires auth
app.post('/telegram/callback', async (req, res, next) => {
  try {
    const secretToken = req.headers[
      'x-telegram-bot-api-secret-token'
    ] as string;
    if (!secretToken) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const team = await Team.findOne({
      'telegramConfig.webhookSecret': secretToken,
    }).select('_id telegramConfig');

    if (!team) {
      return res.status(403).json({ error: 'Invalid secret token' });
    }

    const update = req.body;
    if (update.callback_query) {
      await handleCallback(team._id.toString(), update.callback_query);
    }

    res.sendStatus(200);
  } catch (e) {
    logger.error(e, 'Telegram callback error');
    res.sendStatus(200);
  }
});
app.use('/telegram', isUserAuthenticated, routers.telegramRouter);
// ---------------------------------------------------------------------

// TODO: Separate external API routers from internal routers
// ---------------------------------------------------------------------
// ----------------------- External Routers ----------------------------
// ---------------------------------------------------------------------
// API v2
// Only initialize Swagger in development or if explicitly enabled
if (
  process.env.NODE_ENV !== 'production' &&
  process.env.ENABLE_SWAGGER === 'true'
) {
  // Will require a refactor to ESM to use import statements
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setupSwagger } = require('./utils/swagger');
  setupSwagger(app);
  logger.info('Swagger UI setup and available at /api/v2/docs');
}

app.use('/api/v2', externalRoutersV2);

// error handling
app.use(appErrorHandler);

export default app;
