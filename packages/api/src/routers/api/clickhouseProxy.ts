import { sanitizeUrl } from '@braintree/sanitize-url';
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

/**
 * Validates and sanitizes a URL path to prevent injection attacks.
 * - Recursively decodes to catch double/triple encoding of ? and &
 * - Rejects paths with encoded query string characters in pathname
 * - Prevents protocol-based attacks (javascript:, data:, etc.)
 * - Prevents host injection via protocol-relative URLs
 *
 * @param basePath - The path to validate (may include query string)
 * @returns Sanitized path with pathname and query string
 * @throws Error if path contains malicious patterns
 */
const validateAndSanitizePath = (basePath: string): string => {
  // Extract pathname portion (before any literal ?) for encoding attack check
  // Must be done BEFORE sanitizeUrl because it decodes percent-encoded chars
  const firstQuestionMark = basePath.indexOf('?');
  const rawPathname =
    firstQuestionMark >= 0 ? basePath.slice(0, firstQuestionMark) : basePath;

  // Recursively decode pathname to prevent double-encoding attacks
  // (e.g., %253F -> %3F -> ?, %2526 -> %26 -> &)
  let decodedPathname = rawPathname;
  let prevDecoded = '';
  const maxIterations = 10; // Prevent infinite loops
  let iterations = 0;
  while (decodedPathname !== prevDecoded && iterations < maxIterations) {
    prevDecoded = decodedPathname;
    try {
      decodedPathname = decodeURIComponent(decodedPathname);
    } catch {
      throw new Error('Invalid pathname: malformed URL encoding');
    }
    iterations++;
  }

  // Validate fully-decoded pathname doesn't contain query string characters
  if (decodedPathname.includes('?') || decodedPathname.includes('&')) {
    throw new Error('Invalid pathname: contains query string characters');
  }

  // Sanitize URL to prevent protocol-based attacks (javascript:, data:, etc.)
  const sanitizedPath = sanitizeUrl(basePath);
  if (sanitizedPath === 'about:blank') {
    throw new Error('Invalid pathname: potentially malicious URL');
  }

  // Use URL parsing to properly separate pathname from query params
  const parsedUrl = new URL(sanitizedPath, 'http://localhost');

  // Prevent host injection via protocol-relative URLs (e.g., //evil.com)
  if (parsedUrl.hostname !== 'localhost') {
    throw new Error('Invalid pathname: host injection attempt');
  }

  return `${parsedUrl.pathname}${parsedUrl.search}`;
};

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
      console.error('Error setting up proxy hdx connection', e);
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
      const sanitizedPath = validateAndSanitizePath(
        path.replace(/^\/clickhouse-proxy/, ''),
      );

      const parsedUrl = new URL(sanitizedPath, 'http://localhost');
      const { searchParams, pathname } = parsedUrl;

      // Append user email as custom ClickHouse setting for query log annotation if the prefix was set
      const hyperdxSettingPrefix = req._hdx_connection?.hyperdxSettingPrefix;
      if (hyperdxSettingPrefix) {
        const userEmail = req.user?.email;
        if (userEmail) {
          const userSettingKey = `${hyperdxSettingPrefix}${CUSTOM_SETTING_KEY_SEP}${CUSTOM_SETTING_KEY_USER_SUFFIX}`;
          searchParams.set(userSettingKey, userEmail);
        } else {
          logger.debug('hyperdxSettingPrefix set, no session user found');
        }
      }

      return `${pathname}?${searchParams.toString()}`;
    },
    router: _req => {
      if (!_req._hdx_connection?.host) {
        throw new Error('[createProxyMiddleware] Connection not found');
      }
      return _req._hdx_connection.host;
    },
    on: {
      proxyReq: (proxyReq, _req, res) => {
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

        if (_req.method !== 'POST') {
          console.error(`Unsupported method ${_req.method}`);
          return res.sendStatus(405);
        }

        let body = _req.body;
        if (_req.headers['content-type'] === 'application/json') {
          try {
            body = JSON.stringify(body);
          } catch (e) {
            console.error(e);
          }
        }

        try {
          // TODO: Use fixRequestBody after this issue is resolved: https://github.com/chimurai/http-proxy-middleware/issues/1102
          const body = _req.body;
          proxyReq.setHeader(
            'content-length',
            Buffer.byteLength(body, 'utf-8'),
          );
          proxyReq.write(body);
        } catch (e) {
          console.error(
            `clickhouseProxy error writing body, body is type ${typeof body}`,
          );
          throw e;
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
