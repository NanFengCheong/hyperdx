/**
 * HyperDX Theme Constants
 *
 * Shared theme values for email templates and other non-UI components.
 * These values are synchronized with the Mantine theme in:
 * packages/app/src/theme/themes/hyperdx/mantineTheme.ts
 */

export const hyperdxTheme = {
  fontFamily: '"IBM Plex Sans", monospace',
  white: '#fff',
  fontSizes: {
    xxs: '11px',
    xs: '12px',
    sm: '13px',
    md: '15px',
    lg: '16px',
    xl: '18px',
  },
  colors: {
    green: [
      '#eafff6',
      '#cdfee7',
      '#a0fad5',
      '#63f2bf',
      '#25e2a5',
      '#00c28a',
      '#00a475',
      '#008362',
      '#00674e',
      '#005542',
    ],
    gray: [
      '#FAFAFA',
      '#e6e6ee',
      '#D7D8DB',
      '#aeaeb7',
      '#A1A1AA',
      '#868691',
      '#7e7e8b',
      '#6c6c79',
      '#5f5f6e',
      '#515264',
    ],
    dark: [
      '#C1C2C5',
      '#A6A7AB',
      '#909296',
      '#5C5F66',
      '#373A40',
      '#2C2E33',
      '#25262B',
      '#1A1B1E',
      '#141517',
      '#101113',
    ],
  },
} as const;
