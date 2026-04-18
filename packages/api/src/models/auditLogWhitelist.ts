export const TEAM_SETTINGS_ACTION_PREFIXES = [
  'member',
  'role',
  'permission',
  'group',
  'webhook',
  'apikey',
  'connection',
  'source',
  'policy',
  'integration',
  'telegram',
] as const;

export const TEAM_SETTINGS_ACTION_REGEX = new RegExp(
  `^(${TEAM_SETTINGS_ACTION_PREFIXES.join('|')}):`,
);

export const TEAM_SETTINGS_TARGET_TYPES = [
  'user',
  'role',
  'group',
  'webhook',
  'apikey',
  'connection',
  'source',
  'policy',
  'integration',
  'telegram',
] as const;

export type TeamSettingsTargetType =
  (typeof TEAM_SETTINGS_TARGET_TYPES)[number];
