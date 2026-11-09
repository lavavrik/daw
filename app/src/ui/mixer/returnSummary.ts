// A return strip's header subtitle (plan 29; spec "Mixer layout"): its kind
// plus the one setting that tells two returns of that kind apart, worked out
// from the params so it needs no field in the file and always matches what
// you hear (it is not the preset name):
//   Reverb → the decay time, 1 decimal ("Reverb · 1.8 s");
//   Delay  → the time division's label ("Delay · 3/16").
import { mixParam } from '../../audio/mixerCatalog';
import { KIND_NAME, type ReturnState } from '../../state/returns';

export function returnSummary(r: ReturnState): string {
  if (r.kind === 'reverb') {
    const d = mixParam('rev_decay');
    return `${KIND_NAME.reverb} · ${(r.params[d.id] ?? d.default).toFixed(1)} s`;
  }
  const t = mixParam('delay_time');
  const i = Math.round(r.params[t.id] ?? t.default);
  return `${KIND_NAME.delay} · ${t.choices[i] ?? t.choices[t.default]}`;
}
