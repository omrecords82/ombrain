import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react';

import {
  createSkill,
  listSkills,
  type BrainSkill,
  type SkillLanguage,
} from '../../api/brainApi';

import { useBrainConsole } from '../BrainConsoleContext';
import { PageHeading } from '../components/ConsolePanel';
import ResultPanel from '../components/ResultPanel';

const DEFAULT_SCRIPT = `#!/bin/bash
echo "hello from om-brain skill"
`;

export default function SkillsScreen() {
  const { runBrainCall, refreshHealth } = useBrainConsole();
  const [skills, setSkills] = useState<BrainSkill[]>([]);
  const [query, setQuery] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [skillKey, setSkillKey] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<SkillLanguage>('bash');
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [tags, setTags] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addResult, setAddResult] = useState<import('../types').ResultData | null>(null);

  const loadSkills = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const { result } = await runBrainCall({
      endpoint: 'GET /api/brain/brain/skills',
      action: 'List skills',
      safety: 'read-only',
      call: () => listSkills(),
    });
    if (result.status === 'error') {
      setListError(result.error ?? result.summary);
      setSkills([]);
    } else {
      const data = result.json as { skills?: BrainSkill[] };
      setSkills(data.skills || []);
    }
    setListLoading(false);
  }, [runBrainCall]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filtered = skills.filter((s) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      s.skill_key.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q) ||
      (s.title ?? '').toLowerCase().includes(q)
    );
  });

  const submitSkill = async () => {
    const key = skillKey.trim();
    const body = script.trim();
    if (!key || !body) return;

    setAddLoading(true);
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const { result } = await runBrainCall({
      endpoint: 'POST /api/brain/brain/skills',
      action: `Register skill ${key}`,
      safety: 'proposal-only',
      call: () =>
        createSkill({
          key,
          language,
          script: body,
          description: description.trim() || undefined,
          tags: tagList.length ? tagList : undefined,
        }),
    });
    setAddResult(result);
    setAddLoading(false);
    await loadSkills();
    await refreshHealth();
  };

  return (
    <Stack spacing={3}>
      <PageHeading
        title="Skills"
        description="Governed capability registry. Register executable scripts in skill_memory on om-dev."
        actions={
          <Button
            variant="outlined"
            size="small"
            startIcon={listLoading ? <CircularProgress size={14} /> : <IconRefresh size={16} />}
            onClick={loadSkills}
            disabled={listLoading}
          >
            Refresh
          </Button>
        }
      />

      <Alert severity="info" variant="outlined">
        Registers via <code>POST /api/brain/brain/skills</code>. Unsafe patterns (e.g. <code>rm -rf</code>) are rejected
        by om-brain.
      </Alert>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search skills by name or description..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{ startAdornment: <IconSearch size={18} style={{ marginRight: 8, opacity: 0.5 }} /> }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {filtered.length} of {skills.length} skills
        </Typography>
      </Stack>

      {listError && <Alert severity="error">{listError}</Alert>}

      <Paper variant="outlined">
        {filtered.length ? (
          filtered.map((s) => (
            <Stack
              key={s.skill_key}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'center' }}
              sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}
            >
              <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 180 }}>
                {s.skill_key}
              </Typography>
              <Chip size="small" label={s.language} variant="outlined" />
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                {s.title || s.description || '—'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                v{s.version ?? 1} · runs {s.run_count ?? 0}
              </Typography>
            </Stack>
          ))
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            {listLoading ? 'Loading skills…' : 'No skills loaded yet.'}
          </Typography>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>
          Add skill
        </Typography>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <TextField
              fullWidth
              size="small"
              required
              label="Skill key"
              placeholder="echo-test"
              value={skillKey}
              onChange={(e) => setSkillKey(e.target.value)}
            />
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Language</InputLabel>
              <Select label="Language" value={language} onChange={(e) => setLanguage(e.target.value as SkillLanguage)}>
                <MenuItem value="bash">bash</MenuItem>
                <MenuItem value="python">python</MenuItem>
                <MenuItem value="node">node</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <TextField fullWidth size="small" label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <TextField fullWidth size="small" label="Tags (comma-separated)" value={tags} onChange={(e) => setTags(e.target.value)} />
          <TextField
            fullWidth
            multiline
            minRows={8}
            label="Script body"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            inputProps={{ style: { fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' } }}
          />
          <Button
            variant="contained"
            onClick={submitSkill}
            disabled={addLoading || !skillKey.trim() || !script.trim()}
            startIcon={addLoading ? <CircularProgress size={16} color="inherit" /> : <IconPlus size={16} />}
          >
            POST /brain/skills
          </Button>
          <ResultPanel result={addResult} emptyHint="" />
        </Stack>
      </Paper>
    </Stack>
  );
}
