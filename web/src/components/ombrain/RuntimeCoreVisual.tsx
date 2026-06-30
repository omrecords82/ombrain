import { useEffect, useRef, useState } from 'react';

import type { RuntimeCoreState } from './OMBrainRuntimeCore';

import './RuntimeCoreVisual.css';

export type RuntimeCoreVisualMode = 'animated' | 'reduced-motion' | 'static-offline' | 'static-error' | 'static-failed';

export interface RuntimeCoreVisualProps {
  state: RuntimeCoreState;
  compact?: boolean;
  className?: string;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function resolveVisualMode(
  state: RuntimeCoreState,
  reducedMotion: boolean,
  cssFailed: boolean,
): RuntimeCoreVisualMode {
  if (reducedMotion) return 'reduced-motion';
  if (state === 'offline') return 'static-offline';
  if (state === 'error') return 'static-error';
  if (cssFailed) return 'static-failed';
  return 'animated';
}

export default function RuntimeCoreVisual({ state, compact = false, className = '' }: RuntimeCoreVisualProps) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [cssFailed, setCssFailed] = useState(false);
  const visualMode = resolveVisualMode(state, reducedMotion, cssFailed);

  useEffect(() => {
    if (reducedMotion || state === 'offline' || state === 'error') {
      setCssFailed(false);
      return;
    }

    const ring = zoneRef.current?.querySelector<HTMLElement>('.runtime-core-visual__ring--outer');
    if (!ring) return;

    const frame = window.requestAnimationFrame(() => {
      const computed = window.getComputedStyle(ring);
      const duration = computed.animationDuration;
      const name = computed.animationName;
      const animationsDisabled = name === 'none' || duration === '0s' || duration === '0ms';

      if (animationsDisabled) {
        console.warn(
          '[RuntimeCoreVisual] CSS keyframe animations not active — orb fell back to static. '
          + 'Verify RuntimeCoreVisual.css is bundled (not a stale public/ path).',
          { state, animationName: name, animationDuration: duration },
        );
        setCssFailed(true);
      } else {
        setCssFailed(false);
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, state]);

  return (
    <div
      ref={zoneRef}
      className={`runtime-core-visual${compact ? ' runtime-core-visual--compact' : ''}${className ? ` ${className}` : ''}`}
      data-state={state}
      data-visual-mode={visualMode}
      aria-hidden="true"
    >
      <div className="runtime-core-visual__ring runtime-core-visual__ring--outer" />
      <div className="runtime-core-visual__ring runtime-core-visual__ring--inner" />
      <div className="runtime-core-visual__scan" />
      <div className="runtime-core-visual__particles">
        <span className="runtime-core-visual__particle" />
        <span className="runtime-core-visual__particle" />
        <span className="runtime-core-visual__particle" />
      </div>
      <div className="runtime-core-visual__orb">
        <svg className="runtime-core-visual__orb-neural" viewBox="0 0 60 60" aria-hidden="true">
          <circle cx="30" cy="30" r="3" fill="rgba(255,255,255,0.5)" />
          <circle cx="18" cy="22" r="2" fill="rgba(255,255,255,0.35)" />
          <circle cx="42" cy="24" r="2" fill="rgba(255,255,255,0.35)" />
          <circle cx="24" cy="40" r="2" fill="rgba(255,255,255,0.3)" />
          <circle cx="38" cy="38" r="2" fill="rgba(255,255,255,0.3)" />
          <path
            d="M30 30 L18 22 M30 30 L42 24 M30 30 L24 40 M30 30 L38 38"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="0.75"
            fill="none"
          />
        </svg>
        <span className="runtime-core-visual__orb-center" />
      </div>
    </div>
  );
}
