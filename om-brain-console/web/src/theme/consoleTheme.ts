import { createTheme, type PaletteMode } from '@mui/material';

export const COLOR_MODE_STORAGE_KEY = 'om-brain-console-color-mode';

export function getSystemColorMode(): PaletteMode {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function readStoredColorMode(): PaletteMode | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

/**
 * Operations-cockpit palette — high contrast dark surface by default.
 * Severity colors are tuned for quick scanning at a distance (5-second read).
 */
const SEVERITY = {
  dark: {
    success: { main: '#2ecc71', light: '#5ee092', dark: '#15803d' },
    warning: { main: '#f5a524', light: '#ffc861', dark: '#b45309' },
    error: { main: '#f54e4e', light: '#ff8080', dark: '#b91c1c' },
    info: { main: '#4ea1ff', light: '#7cc0ff', dark: '#1d4ed8' },
  },
  light: {
    success: { main: '#1f8b4c', light: '#4caf73', dark: '#14592f' },
    warning: { main: '#b76e00', light: '#d98c1f', dark: '#7a4900' },
    error: { main: '#c62828', light: '#e05353', dark: '#8e1c1c' },
    info: { main: '#1565c0', light: '#4287d8', dark: '#0d3f82' },
  },
} as const;

export function createConsoleTheme(mode: PaletteMode) {
  const sev = SEVERITY[mode];
  const isDark = mode === 'dark';

  return createTheme({
    palette: {
      mode,
      primary: { main: isDark ? '#a78bfa' : '#5e35b1', contrastText: isDark ? '#0f1117' : '#ffffff' },
      secondary: { main: isDark ? '#4ea1ff' : '#1565c0' },
      success: sev.success,
      warning: sev.warning,
      error: sev.error,
      info: sev.info,
      background: isDark
        ? { default: '#0a0d12', paper: '#12161e' }
        : { default: '#f2f4f7', paper: '#ffffff' },
      divider: isDark ? 'rgba(148, 163, 184, 0.16)' : 'rgba(15, 23, 42, 0.1)',
      text: isDark
        ? { primary: '#eef1f6', secondary: '#9aa6b8' }
        : { primary: '#111827', secondary: '#5b6472' },
    },
    typography: {
      fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
      h4: { fontSize: '1.7rem', fontWeight: 700, letterSpacing: '-0.01em' },
      h5: { fontSize: '1.25rem', fontWeight: 700 },
      h6: { fontSize: '1.05rem', fontWeight: 700 },
      subtitle1: { fontSize: '0.95rem', fontWeight: 600 },
      subtitle2: { fontSize: '0.85rem', fontWeight: 700, letterSpacing: '0.02em' },
      body2: { fontSize: '0.875rem', lineHeight: 1.55 },
      caption: { fontSize: '0.75rem' },
      overline: { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em' },
    },
    shape: { borderRadius: 10 },
    spacing: 8,
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: isDark ? '#3d4450 #12161e' : '#c1c7cd #f2f4f7',
            fontSize: '15px',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          outlined: ({ theme }) => ({
            borderColor: theme.palette.divider,
            backgroundColor: isDark ? '#12161e' : '#ffffff',
          }),
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 600, borderRadius: 8 },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600, borderRadius: 999 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: ({ theme }) => ({
            backgroundColor: theme.palette.action.hover,
            fontWeight: 700,
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: theme.palette.text.secondary,
          }),
          root: { borderColor: isDark ? 'rgba(148, 163, 184, 0.12)' : undefined },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: { fontSize: '0.75rem' },
        },
      },
    },
  });
}

export const severityChipColor: Record<'critical' | 'warning' | 'info', 'error' | 'warning' | 'info'> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
};
