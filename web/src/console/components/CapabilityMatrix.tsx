import { useMemo, useState } from 'react';
import { Box, Typography } from '@mui/material';

import type { BriefingCapabilityReadiness } from '../briefingTypes';
import { capabilityMatrix } from '../capabilities';
import type { CapabilityDetail, SectionId } from '../types';
import { ConsolePanel } from './ConsolePanel';
import CapabilityCard from './CapabilityCard';
import CapabilityDetailDrawer from './CapabilityDetailDrawer';

function mergeWithReadiness(
  base: CapabilityDetail[],
  readiness: BriefingCapabilityReadiness[] | undefined,
): CapabilityDetail[] {
  if (!readiness?.length) return base;
  const byId = new Map(readiness.map((r) => [r.id, r]));
  return base.map((detail) => {
    const live = byId.get(detail.id);
    if (!live) return detail;
    return {
      ...detail,
      state: live.state,
      note: live.reason,
      lastVerified: live.last_verified,
    };
  });
}

export default function CapabilityMatrix({
  readiness,
  onNavigate,
  title = 'Capability Readiness',
  description = 'Live status, gating, and quick actions — driven by the operator briefing model',
}: {
  readiness?: BriefingCapabilityReadiness[];
  onNavigate: (id: SectionId) => void;
  title?: string;
  description?: string;
}) {
  const [selected, setSelected] = useState<CapabilityDetail | null>(null);

  const merged = useMemo(() => mergeWithReadiness(capabilityMatrix, readiness), [readiness]);

  const grouped = useMemo(() => {
    const map = new Map<string, CapabilityDetail[]>();
    for (const item of merged) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category)!.push(item);
    }
    return Array.from(map.entries());
  }, [merged]);

  return (
    <>
      <ConsolePanel title={title} description={description}>
        <Box sx={{ p: 2 }}>
          {grouped.map(([category, items]) => (
            <Box key={category} sx={{ mb: 2.5, '&:last-child': { mb: 0 } }}>
              <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {category}
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(3, 1fr)' },
                  gap: 1.5,
                }}
              >
                {items.map((item) => (
                  <CapabilityCard
                    key={item.id}
                    detail={item}
                    onOpenDetail={setSelected}
                    onQuickAction={(d) => d.navigateTo && onNavigate(d.navigateTo)}
                  />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </ConsolePanel>

      <CapabilityDetailDrawer detail={selected} onClose={() => setSelected(null)} onNavigate={onNavigate} />
    </>
  );
}
