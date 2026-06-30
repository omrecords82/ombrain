import { CssBaseline, ThemeProvider } from '@mui/material';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PaletteMode } from '@mui/material';

import {
  COLOR_MODE_STORAGE_KEY,
  createConsoleTheme,
  getSystemColorMode,
  readStoredColorMode,
} from './consoleTheme';

type ColorModeContextValue = {
  mode: PaletteMode;
  toggleColorMode: () => void;
  setColorMode: (mode: PaletteMode) => void;
};

const ColorModeContext = createContext<ColorModeContextValue | null>(null);

function resolveInitialMode(): PaletteMode {
  return readStoredColorMode() ?? getSystemColorMode();
}

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PaletteMode>(resolveInitialMode);

  useEffect(() => {
    const stored = readStoredColorMode();
    if (stored) return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setMode(event.matches ? 'dark' : 'light');
    };

    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setColorMode = useCallback((next: PaletteMode) => {
    setMode(next);
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, next);
  }, []);

  const toggleColorMode = useCallback(() => {
    setColorMode(mode === 'light' ? 'dark' : 'light');
  }, [mode, setColorMode]);

  const theme = useMemo(() => createConsoleTheme(mode), [mode]);

  const value = useMemo(
    () => ({ mode, toggleColorMode, setColorMode }),
    [mode, toggleColorMode, setColorMode],
  );

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}

export function useColorMode() {
  const ctx = useContext(ColorModeContext);
  if (!ctx) {
    throw new Error('useColorMode must be used within ColorModeProvider');
  }
  return ctx;
}
