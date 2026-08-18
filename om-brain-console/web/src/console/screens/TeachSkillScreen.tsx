import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';
import { IconBook2, IconSend } from '@tabler/icons-react';

import { submitTeachingProposal } from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { PageHeading } from '../components/ConsolePanel';
import ResultPanel from '../components/ResultPanel';
import type { ResultData } from '../types';

export default function TeachSkillScreen() {
  const { runBrainCall } = useBrainConsole();
  const [source, setSource] = useState('operator');
  const [goal, setGoal] = useState('Search docs registry for deployment guides');
  const [evidence, setEvidence] = useState('Repeated operator questions about deploy docs');
  const [riskHint, setRiskHint] = useState('low');
  const [dryRunResult, setDryRunResult] = useState<ResultData | null>(null);
  const [submitResult, setSubmitResult] = useState<ResultData | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);

  const buildInput = () => ({
    source: source.trim() || 'operator',
    goal: goal.trim(),
    evidence: evidence.trim() || undefined,
    risk_hint: riskHint,
    proposed_scope: 'human-gated',
  });

  const validate = () => {
    if (!goal.trim()) return 'Goal is required';
    return null;
  };

  const runDryRun = async () => {
    const err = validate();
    if (err) {
      setDryRunResult({
        status: 'error',
        endpoint: 'POST /api/brain/brain/teach/skill-proposal',
        requestId: 'local',
        latencyMs: 0,
        timestamp: new Date().toISOString(),
        summary: err,
        json: null,
        error: err,
      });
      return;
    }
    setDryRunBusy(true);
    const { result } = await runBrainCall(
      {
        endpoint: 'POST /api/brain/brain/teach/skill-proposal',
        action: 'Compile skill proposal (dry-run)',
        safety: 'proposal-only',
        call: () => submitTeachingProposal(buildInput(), { dryRun: true }),
      },
      'governance',
    );
    setDryRunResult(result);
    setDryRunBusy(false);
  };

  const runSubmit = async () => {
    const err = validate();
    if (err) {
      setSubmitResult({
        status: 'error',
        endpoint: 'POST /api/brain/brain/teach/skill-proposal',
        requestId: 'local',
        latencyMs: 0,
        timestamp: new Date().toISOString(),
        summary: err,
        json: null,
        error: err,
      });
      return;
    }
    setSubmitBusy(true);
    const { result } = await runBrainCall(
      {
        endpoint: 'POST /api/brain/brain/teach/skill-proposal',
        action: 'Submit skill proposal',
        safety: 'human-gated',
        call: () => submitTeachingProposal(buildInput(), { submit: true }),
      },
      'governance',
    );
    setSubmitResult(result);
    setSubmitBusy(false);
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Teach Skill"
        description="Teaching agent v1 — compile skill/procedure proposals. Never executes infrastructure; governance activates approved proposals."
      />

      <Alert severity="info" variant="outlined" icon={<IconBook2 size={18} />}>
        Dry-run validates manifest + RuleEngine. Submit stores a pending proposal in procedure_memory and routes
        medium/high risk to OMStudio governance.
      </Alert>

      <Stack spacing={2}>
        <FormControl size="small" sx={{ maxWidth: 240 }}>
          <InputLabel>Source</InputLabel>
          <Select label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
            <MenuItem value="operator">operator</MenuItem>
            <MenuItem value="correction">correction</MenuItem>
            <MenuItem value="incident">incident</MenuItem>
          </Select>
        </FormControl>

        <TextField
          fullWidth
          required
          label="Goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          helperText="What the skill or procedure should accomplish"
        />

        <TextField
          fullWidth
          multiline
          minRows={3}
          label="Evidence (optional)"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />

        <FormControl size="small" sx={{ maxWidth: 200 }}>
          <InputLabel>Risk hint</InputLabel>
          <Select label="Risk hint" value={riskHint} onChange={(e) => setRiskHint(e.target.value)}>
            <MenuItem value="low">low</MenuItem>
            <MenuItem value="medium">medium</MenuItem>
            <MenuItem value="high">high</MenuItem>
          </Select>
        </FormControl>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button
            variant="outlined"
            onClick={runDryRun}
            disabled={dryRunBusy || !goal.trim()}
            startIcon={dryRunBusy ? <CircularProgress size={16} /> : undefined}
          >
            Dry-run compile
          </Button>
          <Button
            variant="contained"
            onClick={runSubmit}
            disabled={submitBusy || !goal.trim()}
            startIcon={submitBusy ? <CircularProgress size={16} color="inherit" /> : <IconSend size={16} />}
          >
            Submit proposal
          </Button>
        </Stack>

        <ResultPanel result={dryRunResult} emptyHint="Dry-run output appears here." />
        <ResultPanel result={submitResult} emptyHint="Submit output appears here after governance handoff." />
      </Stack>
    </Stack>
  );
}
