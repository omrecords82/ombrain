// Build metadata for the running OMBrain Console bundle.
//
// Injected at build time by the `ombrain-version-stamp` Vite plugin
// (see web/vite.config.ts), which also emits a matching `version.json`
// into the deployed bundle (served same-origin at `/version.json` by the
// console express static server). The frontend compares the baked-in
// `buildId` against the deployed `version.json` to detect a newer deploy.
// Outside a build (e.g. plain `tsc`), the ambient global is undefined and
// we fall back to a "dev" marker.
export interface BuildInfo {
  /** App identifier, e.g. "ombrain". */
  app: string;
  /** Canonical build identity used for comparison (the full git SHA). */
  buildId: string;
  /** Full git commit SHA the bundle was built from. */
  gitSha: string;
  /** Short (7-char) git SHA for display. */
  shortSha: string;
  /** ISO-8601 build timestamp. */
  buildTime: string;
}

declare const __OMBRAIN_BUILD__: BuildInfo | undefined;

export const CURRENT_BUILD: BuildInfo =
  typeof __OMBRAIN_BUILD__ !== 'undefined'
    ? __OMBRAIN_BUILD__
    : {
        app: 'ombrain',
        buildId: 'dev',
        gitSha: 'dev',
        shortSha: 'dev',
        buildTime: new Date().toISOString(),
      };
