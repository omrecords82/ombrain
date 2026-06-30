import { createTheme, type PaletteMode } from '@mui/material';

export const COLOR_MODE_STORAGE_KEY = 'om-brain-console-color-mode';

export function getSystemColorMode(): PaletteMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readStoredColorMode(): PaletteMode | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

export function createConsoleTheme(mode: PaletteMode) {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#9575cd' : '#5e35b1' },
      background:
        mode === 'dark'
          ? { default: '#0f1419', paper: '#1a1f26' }
          : { default: '#f4f6f8', paper: '#ffffff' },
      divider: mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.12)',
    },
    typography: {
      fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    },
    shape: { borderRadius: 8 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: mode === 'dark' ? '#3d4450 #1a1f26' : '#c1c7cd #f4f6f8',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          outlined: ({ theme }) => ({
            borderColor: theme.palette.divider,
          }),
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: ({ theme }) => ({
            backgroundColor: theme.palette.action.hover,
            fontWeight: 600,
          }),
        },
      },
    },
  });
}
