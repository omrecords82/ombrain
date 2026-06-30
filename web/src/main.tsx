import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OMBrainRuntimeProvider } from './contexts/OMBrainRuntimeContext';
import App from './App';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#5e35b1' },
    background: { default: '#f4f6f8', paper: '#ffffff' },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <OMBrainRuntimeProvider>
        <App />
      </OMBrainRuntimeProvider>
    </ThemeProvider>
  </StrictMode>,
);
