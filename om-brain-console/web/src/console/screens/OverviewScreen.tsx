import { useState } from 'react';
import { Alert, Box, Button, Collapse, Paper, Stack } from '@mui/material';
import {
  IconBolt,
  IconChevronDown,
  IconMessage,
  IconSchool,
  IconShieldCheck,
  IconStethoscope,
} from '@tabler/icons-react';

import { useBrainConsole } from '../BrainConsoleContext';
import BrainVerdictPanel from '../components/BrainVerdictPanel';
import CapabilityMatrix from '../components/CapabilityMatrix';
import EventClustersPanel from '../components/EventClustersPanel';
import OperatorActionQueue from '../components/OperatorActionQueue';
import RawEventsTable from '../components/RawEventsTable';
import RecentChangesPanel from '../components/RecentChangesPanel';
import RuntimeCorePanel from '../components/RuntimeCorePanel';
import { buildOverviewActionQueue } from '../operatorActionQueue';
import type { SectionId } from '../types';

const quickActions = [
  { id: 'ask' as SectionId, label: 'Ask Brain', icon: IconMessage },
  { id: 'actions' as SectionId, label: 'Actions', icon: IconBolt },
  { id: 'teach' as SectionId, label: 'Teach Skill', icon: IconSchool },
  { id: 'diagnostics' as SectionId, label: 'Run Diagnostic', icon: IconStethoscope },
  { id: 'governance' as SectionId, label: 'Open Governance', icon: IconShieldCheck },
];

export default function OverviewScreen({ onNavigate }: { onNavigate: (id: SectionId) => void }) {
  const { briefing, briefingLoading, briefingError } = useBrainConsole();
  const [showRaw, setShowRaw] = useState(false);

  const actionQueueItems = buildOverviewActionQueue(briefing?.operator_actions);

  return (
    <Stack spacing={3}>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
        {quickActions.map((a) => {
          const Icon = a.icon;
          return (
            <Button key={a.id} variant="outlined" size="small" startIcon={<Icon size={16} />} onClick={() => onNavigate(a.id)}>
              {a.label}
            </Button>
          );
        })}
      </Stack>

      {briefingError && !briefing && (
        <Alert severity="warning">
          Operator briefing unavailable ({briefingError}). Panels below fall back to direct, per-source checks.
        </Alert>
      )}

      {/* 1. Brain Verdict */}
      <BrainVerdictPanel briefing={briefing} loading={briefingLoading} error={briefingError} />

      {/* 2. Operator Action Queue */}
      <OperatorActionQueue items={actionQueueItems} onNavigate={onNavigate} />

      {/* 3. What Changed Recently */}
      <RecentChangesPanel changes={briefing?.recent_changes ?? []} />

      {/* 4. Capability Readiness */}
      <CapabilityMatrix readiness={briefing?.capability_readiness} onNavigate={onNavigate} />

      {/* 5. Runtime Core */}
      <RuntimeCorePanel />

      {/* 6. Event Clusters */}
      <EventClustersPanel
        clusters={briefing?.event_clusters ?? []}
        suppressedNoise={briefing?.suppressed_noise ?? []}
        limit={8}
        onOpenRaw={() => onNavigate('events')}
      />

      {/* 7. Raw Events drill-down */}
      <Paper variant="outlined">
        <Button
          fullWidth
          onClick={() => setShowRaw((v) => !v)}
          endIcon={
            <IconChevronDown size={16} style={{ transform: showRaw ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }} />
          }
          sx={{ justifyContent: 'space-between', px: 2, py: 1.5, textTransform: 'none', color: 'text.primary' }}
        >
          Raw Events (drill-down)
        </Button>
        <Collapse in={showRaw}>
          <Box sx={{ p: 2, pt: 0 }}>
            <RawEventsTable limit={20} />
          </Box>
        </Collapse>
      </Paper>
    </Stack>
  );
}
