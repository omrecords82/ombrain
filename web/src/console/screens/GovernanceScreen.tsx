import { Alert, Box, Grid, Paper, Stack, Typography, alpha, useTheme } from '@mui/material';
import { IconShieldCheck } from '@tabler/icons-react';

import { useBrainConsole } from '../BrainConsoleContext';
import { CAPABILITIES } from '../capabilities';
import { PageHeading } from '../components/ConsolePanel';
import SafetyBadge from '../components/SafetyBadge';

export default function GovernanceScreen() {
  const theme = useTheme();
  const { brainHealth, proxyHealth } = useBrainConsole();

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Governance"
        description="Review governed actions. Medium and high-risk items are handed off to OMStudio; unsafe actions are blocked at the boundary."
      />

      <Alert
        severity="info"
        icon={<IconShieldCheck size={18} />}
        sx={{ bgcolor: alpha(theme.palette.info.main, 0.08) }}
      >
        OMBrain operates in <strong>{brainHealth?.executes_actions ? 'execute' : 'auditor'}</strong> posture.
        Governance webhook integration uses dry-run outbox by default unless explicitly enabled on om-dev.
      </Alert>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Upstream governance health
            </Typography>
            {brainHealth ? (
              <Stack spacing={1}>
                {'executes_actions' in brainHealth && (
                  <Typography variant="body2">
                    Executes actions: <strong>{brainHealth.executes_actions ? 'yes' : 'no (auditor posture)'}</strong>
                  </Typography>
                )}
                {'llm' in brainHealth && brainHealth.llm && (
                  <Typography variant="body2">
                    LLM circuit: <strong>{String(brainHealth.llm.status)}</strong>
                    {brainHealth.llm.model ? (
                      <>
                        {' '}
                        (<code>{String(brainHealth.llm.model)}</code>)
                      </>
                    ) : null}
                  </Typography>
                )}
                {!brainHealth.llm && 'llm_endpoint_allowed' in brainHealth && (
                  <Typography variant="body2">
                    LLM circuit: <strong>{brainHealth.llm_endpoint_allowed ? 'allowed' : 'blocked'}</strong>
                  </Typography>
                )}
                {'memory_backend' in brainHealth && (
                  <Typography variant="body2">
                    Memory backend: <code>{String(brainHealth.memory_backend)}</code>
                  </Typography>
                )}
                {typeof brainHealth.note === 'string' && brainHealth.note && (
                  <Typography variant="body2" color="text.secondary">
                    {brainHealth.note}
                  </Typography>
                )}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Upstream governance health unavailable — run Refresh in the header.
              </Typography>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Proxy & safety boundaries
            </Typography>
            <Stack spacing={1}>
              <Typography variant="body2">
                Proxy: <strong>{proxyHealth?.ok ? 'OK' : 'unavailable'}</strong>
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <SafetyBadge level="read-only" />
                <SafetyBadge level="diagnostic" />
                <SafetyBadge level="proposal-only" />
                <SafetyBadge level="human-gated" />
                <SafetyBadge level="blocked" />
              </Stack>
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Governance-related capabilities
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {CAPABILITIES.working
            .filter((c) => c.toLowerCase().includes('govern') || c.toLowerCase().includes('omstudio'))
            .map((item) => (
              <Typography key={item} component="li" variant="body2" sx={{ mb: 0.5 }}>
                {item}
              </Typography>
            ))}
        </Box>
      </Paper>
    </Stack>
  );
}
