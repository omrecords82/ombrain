import { useCallback, useEffect, useRef, useState } from 'react';
import { CURRENT_BUILD, type BuildInfo } from './buildInfo';

export interface VersionCheckOptions {
  /** URL of the deployed version file. Defaults to "/version.json". */
  versionUrl?: string;
  /** Poll interval in ms. Defaults to 60_000 (60s). */
  pollIntervalMs?: number;
  /** Build id the app loaded with. Defaults to the baked-in CURRENT_BUILD. */
  currentBuildId?: string;
}

export interface VersionCheckResult {
  updateAvailable: boolean;
  latestBuild: BuildInfo | null;
  /** Dismiss for this session / until a different new build is detected. */
  dismiss: () => void;
  /** Cache-busting hard reload so the new hashed assets are fetched. */
  reload: () => void;
}

const DEFAULT_VERSION_URL = '/version.json';
const DEFAULT_POLL_INTERVAL = 60_000;

/**
 * Detects when a newer build than the one currently loaded has been
 * deployed, by polling the deployed version file and comparing its
 * `buildId` against the build the app loaded with.
 *
 * App-agnostic: point `versionUrl` / `currentBuildId` at any app that
 * emits a `{ buildId, shortSha, buildTime }` version file. This is the
 * reference pattern shared across OM ecosystem frontends (OMStudio,
 * OMWorkshop, OMBrain) and is intended to be reused verbatim.
 */
export function useVersionCheck(options: VersionCheckOptions = {}): VersionCheckResult {
  const {
    versionUrl = DEFAULT_VERSION_URL,
    pollIntervalMs = DEFAULT_POLL_INTERVAL,
    currentBuildId = CURRENT_BUILD.buildId,
  } = options;

  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestBuild, setLatestBuild] = useState<BuildInfo | null>(null);
  // The buildId the operator dismissed with "Later". Cleared implicitly
  // when a *different* new build appears, so the popup returns on the
  // next deploy rather than staying hidden forever.
  const dismissedRef = useRef<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${versionUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const info = (await res.json()) as BuildInfo;
      if (!info || !info.buildId) return;
      if (info.buildId === currentBuildId) return;
      setLatestBuild(info);
      setUpdateAvailable(dismissedRef.current !== info.buildId);
    } catch {
      // offline / transient network error — ignore and retry next tick
    }
  }, [versionUrl, currentBuildId]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), pollIntervalMs);
    const onFocus = () => void check();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [check, pollIntervalMs]);

  const dismiss = useCallback(() => {
    if (latestBuild) dismissedRef.current = latestBuild.buildId;
    setUpdateAvailable(false);
  }, [latestBuild]);

  const reload = useCallback(() => {
    void (async () => {
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch {
        // Cache API unavailable / blocked — a normal reload still pulls
        // the fresh index.html and its new hashed asset references.
      }
      window.location.reload();
    })();
  }, []);

  return { updateAvailable, latestBuild, dismiss, reload };
}

export default useVersionCheck;
