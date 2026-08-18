import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { IconRocket } from '@tabler/icons-react';

import { useVersionCheck, type VersionCheckOptions } from './useVersionCheck';

export interface VersionUpdatePopupProps extends VersionCheckOptions {
  /** Product name shown in the popup copy. Defaults to "OMBrain". */
  appName?: string;
}

/**
 * Bottom-centered, non-blocking "a newer version is available" popup.
 *
 * Re-skinned for the OMBrain Command Console using its MUI 7 theme
 * (`createConsoleTheme` — purple primary, dark cockpit surfaces, with a
 * persisted light/dark toggle). Renders through the app's ThemeProvider so
 * it tracks the active color mode automatically. Self-contained and
 * parameterized (appName / versionUrl / currentBuildId / pollIntervalMs) so
 * it mirrors the OMStudio + OMWorkshop reference pattern and can be ported
 * with only prop changes. Renders nothing until a newer deployed build is
 * detected, so it never blocks the operator workflow.
 */
export default function VersionUpdatePopup({
  appName = 'OMBrain',
  ...options
}: VersionUpdatePopupProps) {
  const { updateAvailable, latestBuild, dismiss, reload } = useVersionCheck(options);

  if (!updateAvailable) return null;

  const buildLabel = latestBuild?.shortSha ?? latestBuild?.buildId?.slice(0, 7) ?? null;
  const builtAt = latestBuild?.buildTime
    ? new Date(latestBuild.buildTime).toLocaleString()
    : null;

  return (
    <Paper
      role="status"
      aria-live="polite"
      elevation={8}
      variant="outlined"
      sx={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
        zIndex: (theme) => theme.zIndex.snackbar + 100,
        width: 'max-content',
        maxWidth: 'min(460px, calc(100vw - 32px))',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        p: 2,
        borderRadius: 3,
        boxShadow: (theme) => theme.shadows[8],
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          width: 36,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          color: 'primary.main',
          bgcolor: (theme) => alpha(theme.palette.primary.main, 0.14),
        }}
      >
        <IconRocket size={20} />
      </Box>
      <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            A newer version of {appName} is available
          </Typography>
          {buildLabel && (
            <Typography variant="caption" color="text.secondary">
              Build {buildLabel}
              {builtAt ? ` \u00b7 ${builtAt}` : ''}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button size="small" color="inherit" onClick={dismiss}>
            Later
          </Button>
          <Button size="small" variant="contained" onClick={reload}>
            Reload Now
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
