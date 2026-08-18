import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// CS-0051 (Non-OMAI Application Version Popup Rollout — Phase 3, OMBrain).
// Resolve the deployed build identity from git at build time. The console
// deploy (deploy/deploy-to-254.sh) builds on the source host at the deployed
// commit, so HEAD is the deployed commit. Never hardcode the SHA; an explicit
// OMBRAIN_BUILD_SHA env var may override (e.g. from a deploy wrapper).
function resolveBuild() {
  let gitSha = process.env.OMBRAIN_BUILD_SHA?.trim() || '';
  if (!gitSha) {
    try {
      gitSha = execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
    } catch {
      gitSha = 'unknown';
    }
  }
  return {
    app: 'ombrain',
    buildId: gitSha,
    gitSha,
    shortSha: gitSha === 'unknown' ? 'unknown' : gitSha.slice(0, 7),
    buildTime: new Date().toISOString(),
  };
}

const BUILD = resolveBuild();

// Emits `version.json` into the built bundle root so the running console can
// poll it (`/version.json`, served same-origin by the express static server)
// and detect newer deploys. Kept in the build itself (not the deploy script)
// so every build stamps a fresh, accurate version.
function versionStampPlugin(): Plugin {
  return {
    name: 'ombrain-version-stamp',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(BUILD, null, 2),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionStampPlugin()],
  // Bake the build identity into the bundle so the app knows which build it
  // loaded with (compared against the polled /version.json).
  define: {
    __OMBRAIN_BUILD__: JSON.stringify(BUILD),
  },
  resolve: {
    alias: {
      '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/brain': { target: 'http://127.0.0.1:8392', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8392', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1600,
  },
});
