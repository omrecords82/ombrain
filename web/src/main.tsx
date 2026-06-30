import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OMBrainRuntimeProvider } from './contexts/OMBrainRuntimeContext';
import { ColorModeProvider } from './theme/ColorModeContext';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorModeProvider>
      <OMBrainRuntimeProvider>
        <App />
      </OMBrainRuntimeProvider>
    </ColorModeProvider>
  </StrictMode>,
);
