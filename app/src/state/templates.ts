// Project templates (plan 27 Task 2; spec 2026-11-19-builtin-content.md §3;
// docs/architecture/projects.md "Templates"): File ▸ New from template ▸
// builds a complete, mixed and arranged house starting point.
//
// A template is DATA (TEMPLATES) made only of shipped content: a built-in
// kit (state/kits.ts), house patches (state/housePatches.ts), factory
// patterns (state/factoryPatterns.ts) and mixer presets
// (state/mixerPresets.ts). buildTemplate turns one into a ProjectJson by
// running the ordinary actions on a fresh, history-less Project (so the
// result is exactly what a user's own edits would have made, and it goes
// through the same validation and load as Open) and serializing it:
//   1. tempo and key (setTempo, setKey);
//   2. tracks: Drums (the kit's eight role rows, EMPTY: the samples are
//      fetched after the load, as the default kit's are, so they are part
//      of the starting point; project/session.ts newFromTemplate ->
//      state/defaultKit.ts loadDefaultKit with the template's kit), Bass,
//      Chords and, where it fits, Pad, each with its patch;
//   3. patterns: every factory pattern a part uses, loaded the factory way
//      (loadFactoryPattern: drum rows by role), transposed from the factory
//      key (A minor) to the template's key (transposeNotes: a plain semitone
//      shift keeps a natural-minor line natural minor); the tracks' empty
//      "Pattern 1" is deleted. Then the template's own adjustments, on its
//      placed copy only (the factory data never changes):
//        - the fill takes the main groove's swing (a 54 % Fill A inside a
//          62 % garage groove would flip the feel for its bar);
//        - `barOrder` re-orders a part's bars (Deep House's pad plays Pad
//          long's chords in the keys' and bass's order: Am9 Dm9 Fmaj7 Em7);
//        - `lowest` folds notes under that pitch up an octave (Garage's sub
//          in F minor would otherwise drop to C1-Eb1, 33-39 Hz, under Bass
//          tidy's high-pass knee);
//   4. the mix: a strip preset per track, then the template's fader and
//      send levels, then Duck to kick on the bass and the pad (AFTER the
//      preset: every track preset rewrites the whole comp section), and the
//      reverb, delay and master presets. BALANCE (plan 27 final review,
//      measured in the running app as each strip's RMS of its meter peaks
//      over 4 bars of the drop, with Duck to kick at -14 dB / 8:1, about
//      7-8 dB on each kick): drums near -10 dB (the master limiter idles),
//      bass 4-5 dB under the drums (the acid line, the lead, about 3.5),
//      chords 5-6 dB under, the pad about 7 dB under (it swells about 3 dB
//      in the break, where nothing ducks it);
//   5. the arrangement (ARRANGEMENT): 32 bars of clips in four 8-bar
//      sections, and the song loop set around them (off).
//
// THE ARRANGEMENT (bars 1-32; a clip longer than its pattern repeats it):
//   intro  1-8   drums only, thinning in: the template's sparse groove for
//                4 bars, then its main groove
//   groove 9-16  drums, bass, chords; Fill A on bar 16
//   break  17-24 no drums and no bass: chords and the pad; Fill A on bar
//                24 is the build into the drop. Its kicks (beats 1-3) are
//                kept on purpose (the plan 27 final review's ruling): the
//                break's "no kick" is bars 17-23, and every shipped fill has
//                a kick
//   drop   25-32 everything
// The pad first enters in the break, so the drop is the only section with
// every part. Each section's block is its own clip, so the playlist shows the
// sections and a section is moved or deleted as a whole.
import { BAR_TICKS, sendParam } from '../audio/protocol';
import { pitchClass } from '../music/scales';
import type { MusicKey } from '../music/scales';
import type { ProjectJson } from '../project/schema';
import { serialize } from '../project/serialize';
import { addDrumTrack, selectTrack, setSwing, setTempo } from './actions';
import type { CommandSink } from './actions';
import { factoryPattern } from './factoryPatterns';
import { setKey } from './key-actions';
import { KIT_ROLES, kitById } from './kits';
import { duckToKick, setMix } from './mixer-actions';
import { applyPreset } from './mixerPresets';
import { BUILTIN_PATCHES } from './patches';
import { deletePattern, selectPattern, transposeNotes, updateNotes } from './pattern-actions';
import { loadFactoryPattern } from './pattern-library';
import { Project, currentPattern } from './project.svelte';
import type { PatternTrack, SynthTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';
import { firstReturnOfKind } from './returns';
import { addClip, setLoop } from './song-actions';

/** The parts a template arranges (one track each). */
export type TemplatePart = 'drums' | 'bass' | 'chords' | 'pad';

/** A part's mixer strip: its preset, then its fader and send levels. */
export interface PartStrip {
  /** Track preset id (state/mixerPresets.ts). */
  preset: string;
  /** Fader in dB: the balance (BALANCE in the header). */
  fader: number;
  /**
   * Send levels in dB to the song's first Reverb / first Delay return, set
   * after the preset (absent: the preset's; a kind with no return: skipped).
   */
  sends?: { reverb?: number; delay?: number };
}

/** A synth part: its track name, house patch (by name), factory pattern (by id) and strip. */
export interface SynthPart extends PartStrip {
  track: string;
  patch: string;
  pattern: string;
  /** Bar i of the placed copy plays the factory pattern's bar barOrder[i] (absent: as written). */
  barOrder?: readonly number[];
  /** Notes below this MIDI pitch (after the transposition) go up an octave (absent: none). */
  lowest?: number;
}

export interface Template {
  id: string;
  /** The menu's label, also the new project's name. */
  name: string;
  /** One line on its character (the menu item's tooltip). */
  blurb: string;
  tempo: number;
  key: MusicKey;
  /** Built-in kit id (state/kits.ts). */
  kit: string;
  /** Factory drum pattern ids: the intro's sparse groove, the main groove, the fill. */
  drums: PartStrip & { intro: string; groove: string; fill: string };
  bass: SynthPart;
  chords: SynthPart;
  pad?: SynthPart;
  /** Mixer preset ids for the returns and the master (state/mixerPresets.ts). */
  reverb: string;
  delay: string;
  master: string;
}

/** The factory synth patterns are written in A minor (state/factoryPatterns.ts header). */
export const FACTORY_KEY: Readonly<MusicKey> = { root: 9, scale: 'minor' };

const A_MINOR: MusicKey = { root: 9, scale: 'minor' };

/**
 * The templates, in menu order (after Empty, which is plain New). Kits,
 * patches, patterns and keys as plan 27's table; presets, faders and sends
 * are this file's choices (docs/architecture/projects.md "Templates" says
 * why).
 */
export const TEMPLATES: readonly Template[] = [
  {
    id: 'deep-house-122', name: 'Deep House 122', tempo: 122, key: A_MINOR, kit: 'deep',
    blurb: 'Round kick and swung shaker, a walking organ bass, m9 keys and a warm pad, in A minor',
    drums: { intro: 'factory-minimal', groove: 'factory-deep-shuffle', fill: 'factory-fill-a', preset: 'kick-punch', fader: -4, sends: { reverb: -26 } },
    bass: { track: 'Bass', patch: 'Organ Bass', pattern: 'factory-deep-walk', preset: 'bass-tidy', fader: -0.5 },
    chords: { track: 'Keys', patch: 'Tine Keys', pattern: 'factory-deep-m9-progression', preset: 'stab-space', fader: -4 },
    // Pad long is Am9 Fmaj7 Dm9 Em7: bars 2 and 3 swapped to follow the keys and the walk (Am Dm F Em).
    pad: { track: 'Pad', patch: 'Warm Pad', pattern: 'factory-pad-long', preset: 'pad-wash', fader: -4.5, barOrder: [0, 2, 1, 3] },
    // Deep house sits in a dark, damped space; the dotted-8th dub echo on the keys.
    reverb: 'dark', delay: 'delay-dub', master: 'master-warm',
  },
  {
    id: 'garage-130', name: 'Garage 130', tempo: 130, key: { root: 5, scale: 'minor' }, kit: 'garage',
    blurb: 'Skipping 2-step drums, a sub bass and a stabbing organ, in F minor',
    // Speed garage thins in with the garage feel (a four-on-the-floor kick at 60 %) before the 2-step.
    drums: { intro: 'factory-speed-garage', groove: 'factory-garage-2-step', fill: 'factory-fill-a', preset: 'kick-punch', fader: -4, sends: { reverb: -24 } },
    // Bar 2 (Db1 Eb1 C1 after the shift) folds up an octave: nothing under E1 (28).
    bass: { track: 'Bass', patch: 'Sub Bass', pattern: 'factory-garage-sub', preset: 'bass-tidy', fader: 0, lowest: 28 },
    chords: { track: 'Organ', patch: 'Garage Organ', pattern: 'factory-garage-organ', preset: 'stab-space', fader: -5 },
    // A bright plate on the snare and organ; eighths bouncing left-right.
    reverb: 'plate', delay: 'delay-pingpong', master: 'master-clean',
  },
  {
    id: 'acid-126', name: 'Acid 126', tempo: 126, key: A_MINOR, kit: 'drum-machine',
    blurb: 'A 909-ish classic house groove, a 303 line and an M1 organ stab, in A minor',
    drums: { intro: 'factory-four-on-the-floor', groove: 'factory-classic-house', fill: 'factory-fill-a', preset: 'kick-punch', fader: -5, sends: { reverb: -26 } },
    // The acid line is the lead: a dub echo under it, as the classic records have.
    bass: { track: 'Acid', patch: 'Acid Line', pattern: 'factory-acid-303-line', preset: 'bass-tidy', fader: -2, sends: { delay: -20 } },
    chords: { track: 'Stab', patch: 'Piano Stab', pattern: 'factory-classic-m1-stab', preset: 'stab-space', fader: -6 },
    reverb: 'room', delay: 'delay-dub', master: 'master-clean',
  },
  {
    id: 'tech-house-125', name: 'Tech House 125', tempo: 125, key: { root: 7, scale: 'minor' }, kit: 'drum-machine',
    blurb: 'Tight drums, a rolling Reese, a dub brass chord and strings, in G minor',
    drums: { intro: 'factory-minimal', groove: 'factory-tech-house', fill: 'factory-fill-a', preset: 'kick-punch', fader: -5, sends: { reverb: -28 } },
    bass: { track: 'Bass', patch: 'Reese Bass', pattern: 'factory-rolling-16ths', preset: 'bass-tidy', fader: -0.5 },
    // Dub chord's echoes are written a dotted 8th apart: more of the 3/16 delay thickens them.
    chords: { track: 'Stab', patch: 'Brass Stab', pattern: 'factory-dub-chord', preset: 'stab-space', fader: -4, sends: { delay: -10 } },
    pad: { track: 'Strings', patch: 'Strings', pattern: 'factory-pad-long', preset: 'pad-wash', fader: -6 },
    reverb: 'hall', delay: 'delay-dub', master: 'master-warm',
  },
];

/** File ▸ New from template ▸ Empty: plain New (the default kit's drum track), not a TEMPLATES entry. */
export const EMPTY_TEMPLATE_ID = 'empty';

/** The submenu, in order: Empty, then TEMPLATES. */
export const TEMPLATE_MENU: readonly { id: string; name: string; blurb: string }[] = [
  { id: EMPTY_TEMPLATE_ID, name: 'Empty', blurb: 'A drum track with the starter kit, as File ▸ New' },
  ...TEMPLATES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb })),
];

/** The template with id `id`, or undefined. */
export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** A clip of the arrangement: which pattern, from bar `bar` (0-based) for `bars` bars. */
export interface ArrangedClip {
  bar: number;
  bars: number;
  /** For drums: the template's intro / groove / fill pattern; synth parts have one pattern. */
  pattern: 'intro' | 'groove' | 'fill' | 'main';
}

/** Bars per section, and the song's length. */
export const SECTION_BARS = 8;
export const SONG_BARS = 4 * SECTION_BARS;

/** Where each part plays (see THE ARRANGEMENT in the header). */
export const ARRANGEMENT: Readonly<Record<TemplatePart, readonly ArrangedClip[]>> = {
  drums: [
    { bar: 0, bars: 4, pattern: 'intro' }, // intro, thin
    { bar: 4, bars: 4, pattern: 'groove' }, // intro, full
    { bar: 8, bars: 7, pattern: 'groove' }, // groove
    { bar: 15, bars: 1, pattern: 'fill' }, // groove's last bar
    { bar: 23, bars: 1, pattern: 'fill' }, // break's last bar
    { bar: 24, bars: 8, pattern: 'groove' }, // drop
  ],
  bass: [
    { bar: 8, bars: 8, pattern: 'main' },
    { bar: 24, bars: 8, pattern: 'main' },
  ],
  chords: [
    { bar: 8, bars: 8, pattern: 'main' },
    { bar: 16, bars: 8, pattern: 'main' },
    { bar: 24, bars: 8, pattern: 'main' },
  ],
  pad: [
    { bar: 16, bars: 8, pattern: 'main' },
    { bar: 24, bars: 8, pattern: 'main' },
  ],
};

/** How many clips template `t` places (its parts' arrangements). */
export const templateClipCount = (t: Template) =>
  ARRANGEMENT.drums.length + ARRANGEMENT.bass.length + ARRANGEMENT.chords.length + (t.pad ? ARRANGEMENT.pad.length : 0);

/**
 * Semitones from the factory key to `key`, the nearer way (-6..+5): A minor
 * to F minor is -4, to G minor -2, so lines stay in their register.
 */
export function factoryShift(key: MusicKey): number {
  const up = pitchClass(key.root - FACTORY_KEY.root);
  return up > 5 ? up - 12 : up;
}

/** The build's engine: nothing listens (the ProjectJson is loaded through the real engine later). */
const NO_ENGINE: CommandSink = { send: () => true };

const fail = (t: Template, what: string): never => {
  throw new Error(`Template "${t.name}": ${what}`);
};

/** Load factory pattern `id` into `track` (a new current pattern); its id. */
function loadPattern(p: Project, t: Template, track: PatternTrack, id: string, shift = 0): string {
  if (!factoryPattern(id)) fail(t, `no factory pattern "${id}"`);
  const r = loadFactoryPattern(p, NO_ENGINE, track.id, id);
  if (!r || r.dropped) fail(t, `factory pattern "${id}" didn't load whole`);
  if (shift) transposeNotes(p, NO_ENGINE, track.id, [], shift);
  return r!.pattern.id;
}

/**
 * The template's adjustments to the placed copy of a synth part's pattern
 * (the current one; see the header): re-order its bars, fold its lowest
 * notes up an octave.
 */
function adjustNotes(p: Project, t: Template, track: SynthTrack, part: SynthPart) {
  const pat = currentPattern(track);
  const changes: { id: string; pitch?: number; start?: number }[] = [];
  for (const n of pat.notes) {
    const c: { id: string; pitch?: number; start?: number } = { id: n.id };
    if (part.barOrder) {
      if (part.barOrder.length !== pat.bars) fail(t, `${part.track}: barOrder needs ${pat.bars} bars`);
      const from = Math.floor(n.start / BAR_TICKS);
      const to = part.barOrder.indexOf(from);
      if (to < 0) fail(t, `${part.track}: barOrder drops bar ${from + 1}`);
      if (to !== from) c.start = n.start + (to - from) * BAR_TICKS;
    }
    if (part.lowest !== undefined && n.pitch < part.lowest) c.pitch = n.pitch + 12;
    if (c.start !== undefined || c.pitch !== undefined) changes.push(c);
  }
  if (changes.length) updateNotes(p, NO_ENGINE, track.id, changes);
}

/** The track's starting "Pattern 1" goes (the factory loads are its patterns). */
function dropFirstPattern(p: Project, track: PatternTrack, firstId: string) {
  deletePattern(p, NO_ENGINE, track.id, firstId);
}

/** Clips for `part` on `track`, each playing `patterns[clip.pattern]`. */
function arrange(p: Project, t: Template, track: PatternTrack, part: TemplatePart, patterns: Partial<Record<ArrangedClip['pattern'], string>>) {
  for (const c of ARRANGEMENT[part]) {
    const patternId = patterns[c.pattern] ?? fail(t, `${part} has no ${c.pattern} pattern`);
    const clip = addClip(p, NO_ENGINE, track.id, { start: c.bar * BAR_TICKS, len: c.bars * BAR_TICKS, patternId });
    if (!clip) fail(t, `couldn't place a ${part} clip at bar ${c.bar + 1}`);
  }
}

/**
 * Strip preset, then the fader and send levels. The sends go to the first
 * Reverb / Delay return of `p` (their slot's send_x), not to a fixed knob.
 * Exported for the test that builds on a project with another layout.
 */
export function applyStripMix(p: Project, t: Template, trackId: string, strip: PartStrip) {
  if (!applyPreset(p, NO_ENGINE, trackId, strip.preset)) fail(t, `preset "${strip.preset}" didn't apply`);
  setMix(p, NO_ENGINE, trackId, 'fader', strip.fader);
  for (const [kind, db] of [['reverb', strip.sends?.reverb], ['delay', strip.sends?.delay]] as const) {
    const r = firstReturnOfKind(p, kind);
    if (r && db !== undefined) setMix(p, NO_ENGINE, trackId, sendParam(r.slot), db);
  }
}
const mix = applyStripMix;

/** A synth part's track: its patch, its (transposed) factory pattern, its strip; null for an absent part. */
function synthPart(p: Project, t: Template, part: SynthPart, shift: number) {
  const patch = BUILTIN_PATCHES.find((x) => x.name === part.patch) ?? fail(t, `no patch "${part.patch}"`);
  const track = addSynthTrack(p, NO_ENGINE, part.track, patch) ?? fail(t, `no room for ${part.track}`);
  const first = currentPattern(track).id;
  const main = loadPattern(p, t, track, part.pattern, shift);
  adjustNotes(p, t, track, part);
  dropFirstPattern(p, track, first);
  mix(p, t, track.id, part);
  return { track, main };
}

/**
 * Template `id` as a project file (see the header). Throws for an unknown
 * id, or when shipped content it names is missing (templates.test.ts builds
 * every template, so that is a test failure, never a user's).
 */
export function buildTemplate(id: string): ProjectJson {
  const t = templateById(id) ?? fail({ name: id } as Template, 'unknown template');
  const p = new Project(); // no history: nothing below is an undo entry
  p.name = t.name;
  setTempo(p, NO_ENGINE, t.tempo);
  setKey(p, NO_ENGINE, t.key);
  const shift = factoryShift(t.key);

  // Drums: the kit's role rows (the samples land after the load).
  if (!kitById(t.kit)) fail(t, `no kit "${t.kit}"`);
  const drums = addDrumTrack(p, NO_ENGINE, 'Drums', [...KIT_ROLES]) ?? fail(t, 'no room for Drums');
  const firstDrums = currentPattern(drums).id;
  const intro = loadPattern(p, t, drums, t.drums.intro);
  const fill = loadPattern(p, t, drums, t.drums.fill);
  // The fill (current now) plays at the groove's swing: this copy only.
  const main = factoryPattern(t.drums.groove);
  if (main?.kind !== 'drum') fail(t, `"${t.drums.groove}" is not a drum pattern`);
  else setSwing(p, NO_ENGINE, drums.id, main.swing);
  const groove = loadPattern(p, t, drums, t.drums.groove);
  dropFirstPattern(p, drums, firstDrums);
  mix(p, t, drums.id, t.drums);

  const bass = synthPart(p, t, t.bass, shift);
  const chords = synthPart(p, t, t.chords, shift);
  const pad = t.pad ? synthPart(p, t, t.pad, shift) : null;

  // The pump: bass and pad keyed from the Kick row, after their presets.
  for (const part of [bass, pad]) {
    if (!part) continue;
    const r = duckToKick(p, NO_ENGINE, part.track.id);
    if (!r.ok) fail(t, r.reason);
  }
  for (const [ch, preset] of [['reverb', t.reverb], ['delay', t.delay], ['master', t.master]] as const) {
    if (!applyPreset(p, NO_ENGINE, ch, preset)) fail(t, `${ch} preset "${preset}" didn't apply`);
  }

  arrange(p, t, drums, 'drums', { intro, groove, fill });
  arrange(p, t, bass.track, 'bass', { main: bass.main });
  arrange(p, t, chords.track, 'chords', { main: chords.main });
  if (pad) arrange(p, t, pad.track, 'pad', { main: pad.main });
  setLoop(p, NO_ENGINE, { on: false, start: 0, end: SONG_BARS * BAR_TICKS });

  // The step grid opens on the main groove of the drums.
  selectPattern(p, NO_ENGINE, drums.id, groove);
  selectTrack(p, NO_ENGINE, drums.id);
  return serialize(p);
}

/**
 * The page URL's `?template=<id>` (App.svelte onstarted): open that template
 * at start-up in place of the default drum track, e.g. a link to
 * `/?template=deep-house-122`. `{ id }` for a TEMPLATES id, `{ unknown }`
 * for any other value (start-up stays the default; App shows a banner), null
 * when the parameter is absent or empty. `empty` counts as absent: it is
 * the default start-up anyway.
 */
export function templateFromUrl(search: string): { id: string } | { unknown: string } | null {
  const v = new URLSearchParams(search).get('template')?.trim();
  if (!v || v === EMPTY_TEMPLATE_ID) return null;
  return templateById(v) ? { id: v } : { unknown: v };
}
