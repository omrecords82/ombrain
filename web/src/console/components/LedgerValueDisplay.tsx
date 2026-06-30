import { Box, Collapse, Typography, type TypographyProps } from '@mui/material';
import { useState } from 'react';

import {
  formatLedgerValue,
  isExpandableLedgerValue,
} from '../../utils/formatDisplayValue';

type LedgerValueDisplayProps = {
  value: unknown;
  noWrap?: boolean;
  variant?: TypographyProps['variant'];
};

export default function LedgerValueDisplay({
  value,
  noWrap,
  variant = 'body2',
}: LedgerValueDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const displayText = formatLedgerValue(value);
  const expandable = isExpandableLedgerValue(value);

  if (!expandable) {
    return (
      <Typography variant={variant} noWrap={noWrap} title={displayText}>
        {displayText}
      </Typography>
    );
  }

  const preview = Array.isArray(value)
    ? `${value.length} items`
    : `${displayText.split('\n')[0]}…`;

  return (
    <Box>
      <Typography
        variant={variant}
        noWrap={noWrap}
        title={displayText}
        onClick={() => setExpanded((open) => !open)}
        sx={{ cursor: 'pointer', color: 'primary.main' }}
      >
        {preview} {expanded ? '▾' : '▸'}
      </Typography>
      <Collapse in={expanded} unmountOnExit>
        <Box
          component="pre"
          sx={{
            mt: 0.5,
            p: 1,
            maxHeight: 200,
            overflow: 'auto',
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            bgcolor: 'action.hover',
            borderRadius: 1,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {displayText}
        </Box>
      </Collapse>
    </Box>
  );
}
