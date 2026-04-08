const env = process.env;

// DEFAULTS
const DEFAULT_APP_TYPE = 'api';
const DEFAULT_EXPRESS_SESSION = 'hyperdx is cool 👋';
const DEFAULT_FRONTEND_URL = `http://localhost:${env.HYPERDX_APP_PORT}`;

export const NODE_ENV = env.NODE_ENV as string;

export const APP_TYPE = (env.APP_TYPE || DEFAULT_APP_TYPE) as
  | 'api'
  | 'scheduled-task';
export const CODE_VERSION = env.CODE_VERSION ?? '';
export const EXPRESS_SESSION_SECRET = (env.EXPRESS_SESSION_SECRET ||
  DEFAULT_EXPRESS_SESSION) as string;
export const FRONTEND_URL = (env.FRONTEND_URL ||
  DEFAULT_FRONTEND_URL) as string;
const HYPERDX_IMAGE = env.HYPERDX_IMAGE;
export const IS_APP_IMAGE = HYPERDX_IMAGE === 'hyperdx';
export const IS_ALL_IN_ONE_IMAGE = HYPERDX_IMAGE === 'all-in-one-auth';
export const IS_LOCAL_IMAGE = HYPERDX_IMAGE === 'all-in-one-noauth';
export const INGESTION_API_KEY = env.INGESTION_API_KEY ?? '';
export const HYPERDX_API_KEY = env.HYPERDX_API_KEY as string;
export const HYPERDX_LOG_LEVEL = env.HYPERDX_LOG_LEVEL as string;
export const IS_CI = NODE_ENV === 'test';
export const IS_DEV = NODE_ENV === 'development';
export const IS_PROD = NODE_ENV === 'production';
export const MINER_API_URL = env.MINER_API_URL as string;
export const MONGO_URI = env.MONGO_URI;
export const OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME as string;
export const PORT = Number.parseInt(env.PORT as string);
export const OPAMP_PORT = Number.parseInt(env.OPAMP_PORT as string);
export const USAGE_STATS_ENABLED = env.USAGE_STATS_ENABLED !== 'false';
export const RUN_SCHEDULED_TASKS_EXTERNALLY =
  env.RUN_SCHEDULED_TASKS_EXTERNALLY === 'true';

// Only for single container local deployments, disable authentication
export const IS_LOCAL_APP_MODE =
  env.IS_LOCAL_APP_MODE === 'DANGEROUSLY_is_local_app_mode💀';

// Only used to bootstrap empty instances
export const DEFAULT_CONNECTIONS = env.DEFAULT_CONNECTIONS;
export const DEFAULT_SOURCES = env.DEFAULT_SOURCES;

// FOR CI ONLY
export const CLICKHOUSE_HOST = env.CLICKHOUSE_HOST as string;
export const CLICKHOUSE_USER = env.CLICKHOUSE_USER as string;
export const CLICKHOUSE_PASSWORD = env.CLICKHOUSE_PASSWORD as string;

// AI Assistant
// Provider-agnostic configuration (preferred)
export const AI_PROVIDER = env.AI_PROVIDER as string; // 'anthropic' | 'openai'
export const AI_API_KEY = env.AI_API_KEY as string;
export const AI_BASE_URL = env.AI_BASE_URL as string;
export const AI_MODEL_NAME = env.AI_MODEL_NAME as string;
export const AI_REQUEST_HEADERS = env.AI_REQUEST_HEADERS as string;

// Legacy Anthropic-specific configuration (backward compatibility)
export const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY as string;

// OIDC / Entra ID configuration
export const OIDC_ISSUER = env.OIDC_ISSUER as string;
export const OIDC_CLIENT_ID = env.OIDC_CLIENT_ID as string;
export const OIDC_CLIENT_SECRET = env.OIDC_CLIENT_SECRET as string;
export const OIDC_CALLBACK_URL = env.OIDC_CALLBACK_URL as string;
export const OIDC_SCOPE = (env.OIDC_SCOPE || 'openid profile email') as string;
export const OIDC_ALLOWED_DOMAINS = (env.OIDC_ALLOWED_DOMAINS || '') as string;
export const OIDC_ENABLED = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);

// SMTP Configuration
export const SMTP_HOST = env.SMTP_HOST as string;
export const SMTP_PORT = Number.parseInt(env.SMTP_PORT || '587');
export const SMTP_SECURE = env.SMTP_SECURE === 'true';
export const SMTP_USER = env.SMTP_USER as string;
export const SMTP_PASS = env.SMTP_PASS as string;
export const SMTP_FROM = (env.SMTP_FROM || 'noreply@hyperdx.io') as string;
export const SMTP_FROM_NAME = (env.SMTP_FROM_NAME || 'HyperDX') as string;
export const SMTP_ENABLED = !!env.SMTP_HOST;

// OTP / 2FA Configuration
export const OTP_EXPIRY_SECONDS = Number.parseInt(env.OTP_EXPIRY_SECONDS || '300');
export const OTP_MAX_ATTEMPTS = Number.parseInt(env.OTP_MAX_ATTEMPTS || '5');
export const OTP_LOCKOUT_SECONDS = Number.parseInt(env.OTP_LOCKOUT_SECONDS || '900');

// Data Retention Configuration (in days)
export const RETENTION_DAYS_AUDITLOG = Number.parseInt(env.RETENTION_DAYS_AUDITLOG || '90');
export const RETENTION_DAYS_ALERTHISTORY = Number.parseInt(env.RETENTION_DAYS_ALERTHISTORY || '30');
