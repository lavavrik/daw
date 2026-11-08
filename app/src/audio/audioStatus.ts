// What the top bar's audio pill says (spec 2026-11-15 §10; ui/AudioStatusPill.svelte).
//
// There is no start splash: App builds the engine at page load, and the
// browser keeps its AudioContext 'suspended' until the page gets a click or
// a key press. Until then the pill reads "Audio paused — click anywhere to
// start"; once the context runs it is the ⚙ latency pill again; if the
// engine could not be built, or the browser refused to resume (no output
// device), it reads "Audio failed — retry" with the error in its tooltip.

export type AudioStatus =
  /** The engine is being built (a few hundred ms after load): nothing to show yet. */
  | { kind: 'starting' }
  /** Built, waiting for the browser to let audio start (the first gesture). */
  | { kind: 'paused' }
  | { kind: 'running' }
  | { kind: 'failed'; error: string };

/**
 * `engine`: the engine object exists; `state`: its AudioContext's state;
 * `error`: why building or resuming failed (cleared by a retry), else null.
 */
export function audioStatus(o: { engine: boolean; state: AudioContextState | null; error: string | null }): AudioStatus {
  if (o.error !== null) return { kind: 'failed', error: o.error };
  if (!o.engine) return { kind: 'starting' };
  // 'closed' only shows for a moment (an audio restart swaps engines): not "running".
  return o.state === 'running' ? { kind: 'running' } : { kind: 'paused' };
}

export const PAUSED_LABEL = 'Audio paused — click anywhere to start';
export const FAILED_LABEL = 'Audio failed — retry';
export const STARTING_LABEL = 'Starting audio…';

/** The pill's tooltip. */
export function audioStatusTitle(s: AudioStatus): string {
  switch (s.kind) {
    case 'failed':
      return `Audio could not start: ${s.error}. Click to retry.`;
    case 'paused':
      return 'The browser holds audio until you click or press a key on the page. Click to start it now.';
    default:
      return '';
  }
}
