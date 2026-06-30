import { Chip } from '@mui/material';
import {
  IconBan,
  IconEye,
  IconFileText,
  IconStethoscope,
  IconUserCheck,
} from '@tabler/icons-react';

import type { SafetyLevel } from '../types';

const config: Record<
  SafetyLevel,
  { label: string; icon: typeof IconEye; color: 'info' | 'default' | 'warning' | 'error' | 'secondary' }
> = {
  'read-only': { label: 'Read-only', icon: IconEye, color: 'info' },
  diagnostic: { label: 'Diagnostic', icon: IconStethoscope, color: 'default' },
  'proposal-only': { label: 'Proposal-only', icon: IconFileText, color: 'warning' },
  'human-gated': { label: 'Human-gated', icon: IconUserCheck, color: 'warning' },
  blocked: { label: 'Blocked', icon: IconBan, color: 'error' },
};

export default function SafetyBadge({
  level,
  size = 'small',
}: {
  level: SafetyLevel;
  size?: 'small' | 'medium';
}) {
  const { label, icon: Icon, color } = config[level];
  return (
    <Chip
      size={size}
      variant="outlined"
      color={color}
      icon={<Icon size={14} />}
      label={label}
      sx={{ fontWeight: 500 }}
    />
  );
}
