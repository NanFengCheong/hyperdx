import express, { RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as SQLParser from 'node-sql-parser';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import { CODE_VERSION } from '@/config';
import { getConnectionById } from '@/controllers/connection';
import { getNonNullUserWithTeam, getUserDataScope } from '@/middleware/auth';
import { validateRequestHeaders } from '@/middleware/validation';
import logger from '@/utils/logger';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

const CUSTOM_SETTING_KEY_SEP = '_';
const CUSTOM_SETTING_KEY_USER_SUFFIX = 'user';

router.post(
  '/test',
  validateRequest({
    body: z.object({
      host: z.string().url(),
      username: z.string().optional(),
      password: z.string().optional(),
    }),
  }),
  async (req, res) => {
    const { host, username, password } = req.body;
    try {
      const result = await fetch(`${host}/?query=SELECT 1`, {
        headers: {
          'X-ClickHouse-User': username || '',
          'X-ClickHouse-Key': password || '',
        },
        signal: AbortSignal.timeout(2000),
      });
      // For status codes 204-399
      if (!result.ok) {
        const errorText = await result.text();
        return res.status(result.status).json({
          success: false,
          error: errorText || 'Error connecting to ClickHouse server',
        });
      }
      const data = await result.json();
      return res.json({ success: data === 1 });
    } catch (e: any) {
      // fetch returns a 400+ error and throws
      console.error(e);
      const errorMessage =
        e.cause?.code === 'ENOTFOUND'
          ? `Unable to resolve host: ${e.cause.hostname}`
          : e.cause?.message ||
            e.message ||
            'Error connecting to ClickHouse server';

      return res.status(500).json({
        success: false,
        error:
          errorMessage +
          ', please check the host and credentials and try again.',
      });
    }
  },
);

const hasConnectionId = validateRequestHeaders(
  z.object({
    'x-hyperdx-connection-id': objectIdSchema,
  }),
);

const getConnection: RequestHandler =
  // prettier-ignore-next-line
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const connection_id = req.headers['x-hyperdx-connection-id']!; // ! because zod already validated
      delete req.headers['x-hyperdx-connection-id'];
      const hyperdx_connection_id = Array.isArray(connection_id)
        ? connection_id.join('')
        : connection_id;

      const connection = await getConnectionById(
        teamId.toString(),
        hyperdx_connection_id,
        true,
      );

      if (!connection) {
        res.status(404).send('Connection not found');
        return;
      }

      req._hdx_connection = {
        host: connection.host,
        id: connection.id,
        name: connection.name,
        password: connection.password,
        username: connection.username,
        hyperdxSettingPrefix: connection.hyperdxSettingPrefix,
      };
      next();
    } catch (e) {
      console.error('Error fetching connection info:', e);
      next(e);
    }
  };

// --- Data scope injection ---

const sqlParser = new SQLParser.Parser();

const DATA_SCOPE_COLUMN_MAP: Record<string, string> = {
  service: 'ServiceName',
  'service.name': 'ServiceName',
  severity: 'SeverityText',
  level: 'SeverityText',
  trace_id: 'TraceId',
  span_id: 'SpanId',
  'span.name': 'SpanName',
  span_name: 'SpanName',
};

function dataScopeToSqlCondition(dataScope: string): string {
  const terms = dataScope.trim().split(/\s+/);
  const conditions: string[] = [];

  for (const term of terms) {
    const colonIdx = term.indexOf(':');
    if (colonIdx === -1) continue;
    const field = term.substring(0, colonIdx);
    const value = term.substring(colonIdx + 1);
    const column =
      DATA_SCOPE_COLUMN_MAP[field] || `ResourceAttributes['${field}']`;
    const escapedValue = value.replace(/'/g, "\\'");
    conditions.push(`${column} = '${escapedValue}'`);
  }

  return conditions.join(' AND ');
}

function injectWhereIntoSqlAst(stmt: any, conditionAst: any): void {
  if (!stmt || stmt.type !== 'select') return;

  if (stmt.where) {
    stmt.where = {
      type: 'binary_expr',
      operator: 'AND',
      left: stmt.where,
      right: conditionAst,
    };
  } else {
    stmt.where = conditionAst;
  }

  // Recurse into subqueries in FROM
  if (stmt.from) {
    for (const from of stmt.from) {
      if (from.expr?.ast) {
        injectWhereIntoSqlAst(from.expr.ast, conditionAst);
      }
    }
  }
}

const injectDataScope: RequestHandler = (req, res, next) => {
  const dataScope = getUserDataScope(req);
  if (!dataScope) return next();

  const sqlCondition = dataScopeToSqlCondition(dataScope);
  if (!sqlCondition) return next();

  // Query can come from URL query param or POST body
  const query =
    typeof req.query?.query === 'string'
      ? req.query.query
      : typeof req.body === 'string'
        ? req.body
        : undefined;

  if (!query) return next();

  try {
    const ast = sqlParser.astify(query, { database: 'TransactSQL' });

    // Parse the condition AST from a dummy SELECT
    const condAst = sqlParser.astify(`SELECT 1 WHERE ${sqlCondition}`, {
      database: 'TransactSQL',
    });
    const conditionWhere = Array.isArray(condAst)
      ? (condAst[0] as any)?.where
      : (condAst as any)?.where;

    if (conditionWhere) {
      if (Array.isArray(ast)) {
        ast.forEach(stmt => injectWhereIntoSqlAst(stmt, conditionWhere));
      } else {
        injectWhereIntoSqlAst(ast, conditionWhere);
      }

      const modifiedSql = sqlParser.sqlify(ast, { database: 'TransactSQL' });

      if (typeof req.query?.query === 'string') {
        req.query.query = modifiedSql;
      } else {
        req.body = modifiedSql;
      }
    }
  } catch (e) {
    // If SQL cannot be parsed, block the query rather than using a fragile fallback.
    // This prevents data scope bypass via ClickHouse-specific syntax.
    logger.warn(
      { err: e, dataScope },
      'Failed to parse SQL for data scope injection — blocking query',
    );
    return res.status(403).json({
      message:
        'Query could not be validated against your data scope restrictions.',
    });
  }

  next();
};

// --- Proxy ---

const proxyMiddleware: RequestHandler =
  // prettier-ignore-next-line
  createProxyMiddleware({
    target: '', // doesn't matter. it should be overridden by the router
    changeOrigin: true,
    pathFilter: (path, _req) => {
      return _req.method === 'GET' || _req.method === 'POST';
    },
    pathRewrite: function (path, req) {
      // @ts-expect-error _req.query is type ParamQs, which doesn't play nicely with URLSearchParams. TODO: Replace with getting query params from _req.url eventually
      const qparams = new URLSearchParams(req.query);

      // Append user email as custom ClickHouse setting for query log annotation if the prefix was set
      const hyperdxSettingPrefix = req._hdx_connection?.hyperdxSettingPrefix;
      if (hyperdxSettingPrefix) {
        const userEmail = req.user?.email;
        if (userEmail) {
          const userSettingKey = `${hyperdxSettingPrefix}${CUSTOM_SETTING_KEY_SEP}${CUSTOM_SETTING_KEY_USER_SUFFIX}`;
          qparams.set(userSettingKey, userEmail);
        } else {
          logger.debug('hyperdxSettingPrefix set, no session user found');
        }
      }

      const newPath = req.path.replace('^/clickhouse-proxy', '');
      return `/${newPath}?${qparams.toString()}`;
    },
    router: _req => {
      if (!_req._hdx_connection?.host) {
        throw new Error('[createProxyMiddleware] Connection not found');
      }
      return _req._hdx_connection.host;
    },
    on: {
      proxyReq: (proxyReq, _req) => {
        // set user-agent to the hyperdx version identifier
        proxyReq.setHeader('user-agent', `hyperdx ${CODE_VERSION}`);

        if (_req._hdx_connection?.username) {
          proxyReq.setHeader(
            'X-ClickHouse-User',
            _req._hdx_connection.username,
          );
        }
        // Passwords can be empty
        if (_req._hdx_connection?.password) {
          proxyReq.setHeader('X-ClickHouse-Key', _req._hdx_connection.password);
        }

        if (_req.method === 'POST') {
          // TODO: Use fixRequestBody after this issue is resolved: https://github.com/chimurai/http-proxy-middleware/issues/1102
          const body = _req.body;
          proxyReq.setHeader(
            'content-length',
            Buffer.byteLength(body, 'utf-8'),
          );
          proxyReq.write(body);
        }
      },
      proxyRes: (proxyRes, _req, res) => {
        // since clickhouse v24, the cors headers * will be attached to the response by default
        // which will cause the browser to block the response
        if (_req.headers['access-control-request-method']) {
          proxyRes.headers['access-control-allow-methods'] =
            _req.headers['access-control-request-method'];
        }

        if (_req.headers['access-control-request-headers']) {
          proxyRes.headers['access-control-allow-headers'] =
            _req.headers['access-control-request-headers'];
        }

        if (_req.headers.origin) {
          proxyRes.headers['access-control-allow-origin'] = _req.headers.origin;
          proxyRes.headers['access-control-allow-credentials'] = 'true';
        }
      },
      error: (err, _req, _res) => {
        console.error('Proxy error:', err);
        (_res as Response).writeHead(500, {
          'Content-Type': 'application/json',
        });
        _res.end(
          JSON.stringify({
            success: false,
            error: err.message || 'Failed to connect to ClickHouse server',
          }),
        );
      },
    },
    // ...(config.IS_DEV && {
    //   logger: console,
    // }),
  });

router.get(
  '/*',
  hasConnectionId,
  getConnection,
  injectDataScope,
  proxyMiddleware,
);
// Decode base64-encoded body from frontend (bypasses WAF SQL injection detection)
const decodeBase64Body: RequestHandler = (req, _res, next) => {
  if (
    req.headers['x-hdx-body-encoding'] === 'base64' &&
    typeof req.body === 'string'
  ) {
    req.body = Buffer.from(req.body, 'base64').toString('utf-8');
    delete req.headers['x-hdx-body-encoding'];
  }
  next();
};

router.post(
  '/*',
  hasConnectionId,
  getConnection,
  decodeBase64Body,
  injectDataScope,
  proxyMiddleware,
);

export default router;
