import type { BrainHealth, ProxyHealth } from '../api/brainApi';
import type { BriefingOperatorAction } from './briefingTypes';
import { BLOCKERS } from './capabilities';
import type { ActionQueueItem } from './types';

/** Maps the server-synthesized briefing actions onto the frontend queue item shape. */
export function mapBriefingActions(actions: BriefingOperatorAction[]): ActionQueueItem[] {
  return actions.map((a) => ({
    id: a.id,
    severity: a.severity,
    title: a.title,
    explanation: a.explanation,
    recommendedAction: a.recommended_action,
    buttonLabel: a.button_label,
    navigateTo: a.navigate_to,
    safeToAct: a.safe_to_act,
  }));
}

/**
 * Builds the Operator Action Queue from live signals (health, proxy, LLM circuit)
 * plus the known blocker inventory. No fabricated data — every item traces back to
 * a real health field or a documented, currently-true platform gap.
 */
export function buildActionQueue(opts: {
  proxyHealth: ProxyHealth | null;
  brainHealth: BrainHealth | null;
  healthError: string | null;
  consoleOk: boolean;
  upstreamOk: boolean;
}): ActionQueueItem[] {
  const { proxyHealth, brainHealth, healthError, consoleOk, upstreamOk } = opts;
  const items: ActionQueueItem[] = [];

  if (!consoleOk) {
    items.push({
      id: 'aq-console-down',
      severity: 'critical',
      title: 'Console proxy unreachable',
      explanation: 'om-brain-console on om-dev (.254:8392) is not responding to health checks.',
      recommendedAction: 'Check the om-brain-console systemd service on om-dev and confirm nginx LAN edge is up.',
      buttonLabel: 'Open Raw API',
      navigateTo: 'raw',
      safeToAct: true,
    });
  } else if (!upstreamOk) {
    items.push({
      id: 'aq-upstream-down',
      severity: 'critical',
      title: 'om-brain upstream unreachable',
      explanation: healthError || 'The console proxy is up, but om-brain on 127.0.0.1:8390 is not responding.',
      recommendedAction: 'Verify the om-brain service on om-dev (.254:8390) and check recent deploys.',
      buttonLabel: 'Run diagnostics',
      navigateTo: 'diagnostics',
      safeToAct: true,
    });
  }

  const llmStatus = brainHealth?.llm?.status;
  if (llmStatus === 'error') {
    items.push({
      id: 'aq-llm-error',
      severity: 'critical',
      title: 'LLM circuit reporting an error',
      explanation: brainHealth?.llm?.last_error
        ? String(brainHealth.llm.last_error)
        : 'The LLM inference circuit is reporting an error state.',
      recommendedAction: 'Check the local inference gateway logs on om-dev and confirm the model is loaded.',
      buttonLabel: 'Open diagnostics',
      navigateTo: 'diagnostics',
      safeToAct: true,
    });
  } else if (llmStatus === 'disabled' || brainHealth?.llm_endpoint_allowed === false) {
    items.push({
      id: 'aq-llm-blocked',
      severity: 'warning',
      title: 'LLM circuit disabled or blocked',
      explanation: brainHealth?.llm_endpoint_reason
        ? String(brainHealth.llm_endpoint_reason)
        : 'Ask Brain and Theology answers that require the LLM will degrade to retrieval-only.',
      recommendedAction: 'Review the circuit breaker reason on om-dev; re-enable once the upstream model endpoint is healthy.',
      buttonLabel: 'Ask Brain',
      navigateTo: 'ask',
      safeToAct: true,
    });
  } else if (llmStatus === 'not_configured') {
    items.push({
      id: 'aq-llm-not-configured',
      severity: 'warning',
      title: 'LLM endpoint not configured',
      explanation: 'om-brain has no BRAIN_LLM_BASE_URL configured — generative answers are unavailable.',
      recommendedAction: 'Configure BRAIN_LLM_BASE_URL on om-dev to enable generative responses.',
      buttonLabel: 'Open governance',
      navigateTo: 'governance',
      safeToAct: true,
    });
  }

  if (proxyHealth && proxyHealth.google_places_configured === false) {
    items.push({
      id: 'aq-places',
      severity: 'warning',
      title: 'Church Finder running cache-only',
      explanation: 'GOOGLE_PLACES_API_KEY is not set on OMAI — live parish search is unavailable.',
      recommendedAction: 'Set GOOGLE_PLACES_API_KEY in OMStudio Platform Secrets to restore live search.',
      buttonLabel: 'Open Church Finder',
      navigateTo: 'churches',
      safeToAct: true,
    });
  }

  if (consoleOk && upstreamOk && !healthError) {
    items.push({
      id: 'aq-all-clear',
      severity: 'info',
      title: 'No critical issues detected',
      explanation: 'Console proxy and om-brain upstream are both reachable on the last health check.',
      recommendedAction: 'No action needed — keep monitoring the status strip.',
      safeToAct: true,
    });
  }

  for (const blocker of BLOCKERS) {
    if (blocker.id === 'bl-places' && items.some((i) => i.id === 'aq-places')) continue;
    items.push({
      id: `aq-${blocker.id}`,
      severity: blocker.severity,
      title: blocker.name,
      explanation: blocker.impact,
      recommendedAction: blocker.requiredFix,
      navigateTo: 'capabilities',
      buttonLabel: 'View capability',
      safeToAct: true,
    });
  }

  const order: Record<ActionQueueItem['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Primary entry point for the Overview's Operator Action Queue.
 * Prefers the live briefing model (health + event-cluster derived actions),
 * then layers in the static, documented blocker inventory that the briefing
 * service has no way to probe (secrets/config it cannot see from om-dev).
 */
export function buildOverviewActionQueue(briefingActions: BriefingOperatorAction[] | undefined): ActionQueueItem[] {
  const order: Record<ActionQueueItem['severity'], number> = { critical: 0, warning: 1, info: 2 };

  if (!briefingActions) return [];

  const base = mapBriefingActions(briefingActions).filter((i) => i.id !== 'all-clear');
  const existingIds = new Set(base.map((i) => i.id));

  for (const blocker of BLOCKERS) {
    const mappedId = `aq-${blocker.id}`;
    if (existingIds.has(mappedId)) continue;
    base.push({
      id: mappedId,
      severity: blocker.severity,
      title: blocker.name,
      explanation: blocker.impact,
      recommendedAction: blocker.requiredFix,
      navigateTo: 'capabilities',
      buttonLabel: 'View capability',
      safeToAct: true,
    });
  }

  if (!base.length) {
    base.push({
      id: 'all-clear',
      severity: 'info',
      title: 'No critical issues detected',
      explanation: 'All probed subsystems responded successfully on this check.',
      recommendedAction: 'No action needed — keep monitoring the status strip.',
      safeToAct: true,
    });
  }

  return base.sort((a, b) => order[a.severity] - order[b.severity]);
}
