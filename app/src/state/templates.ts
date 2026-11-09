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
//      "Pattern 1" is deleted;
//   4. the mix: a strip preset per track, then the template's fader and
//      send levels, then Duck to kick on the bass and the pad (AFTER the
//      preset: every track preset rewrites the whole comp section), and the
//      reverb, delay and master presets. BALANCE: the faders come from
//      meter readings in the running app (each strip's RMS of its meter
//      peaks over 4 bars of the drop): drums near -10 dB, chords -15, bass
//      and pad as close to -16 as the +6 dB fader allows. Duck to kick's
//      fixed values (-30 dB, 8:1, keyed from a kick near 0 dBFS) take
//      10-15 dB off the bass and pad under a four-on-the-floor kick, which
//      is why their faders sit high. That also leaves the master limiter
//      headroom instead of riding it;
//   5. the arrangement (ARRANGEMENT): 32 bars of clips in four 8-bar
//      sections, and the song loop set around them (off).
//
// THE ARRANGEMENT (bars 1-32; a clip longer than its pattern repeats it):
//   intro  1-8   drums only, thinning in: the template's sparse groove for
//                4 bars, then its main groove
//   groove 9-16  drums, bass, chords; Fill A on bar 16
//   break  17-24 no kick and no bass: chords and the pad; Fill A on bar 24
//                brings the drums back for the drop
//   drop   25-32 everything
// The pad first enters in the break, so the drop is the only section with
// every part. Each section's block is its own clip, so the playlist shows the
// sections and a section is moved or deleted as a whole.
import { BAR_TICKS } from '../audio/protocol';
import { pitchClass } from '../music/scales';
import type { MusicKey } from '../music/scales';
import type { ProjectJson } from '../project/schema';
import { serialize } from '../project/serialize';
import { addDrumTrack, selectTrack, setTempo } from './actions';
import type { CommandSink } from './actions';
import { factoryPattern } from './factoryPatterns';
import { setKey } from './key-actions';
import { KIT_ROLES, kitById } from './kits';
import { duckToKick, setMix } from './mixer-actions';
import { applyPreset } from './mixerPresets';
import { BUILTIN_PATCHES } from './patches';
import { deletePattern, selectPattern, transposeNotes } from './pattern-actions';
import { loadFactoryPattern } from './pattern-library';
import { Project, currentPattern } from './project.svelte';
import type { PatternTrack } from './project.svelte';
import { addSynthTrack } from './rack-actions';
import { addClip, setLoop } from './song-actions';

/** The parts a template arranges (one track each). */
export type TemplatePart = 'drums' | 'bass' | 'chords' | 'pad';

/** A part's mixer strip: its preset, then its fader and send levels. */
export interface PartStrip {
  /** Track preset id (state/mixerPresets.ts). */
  preset: string;
  /** Fader in dB: the balance (BALANCE in the header). */
  fader: number;
  /** Send A (reverb) / Send B (delay) levels in dB, set after the preset (absent: the preset's). */
  sends?: { a?: number; b?: number };
}

/** A synth part: its track name, house patch (by name), factory pattern (by id) and strip. */
export interface SynthPart extends PartStrip {
  track: string;
  patch: string;
  pattern: string;
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
    drums: { intro: 'factory-minimal', groove: 'factory-deep-shuffle', fill: 'factory-fill-a', preset: 'kick-punch', fader: -4, sends: { a: -26 } },
    bass: { track: 'Bass', patch: 'Organ Bass', pattern: 'factory-deep-walk', preset: 'bass-tidy', fader: 6 },
    chords: { track: 'Keys', patch: 'Tine Keys', pattern: 'factory-deep-m9-progression', preset: 'stab-space', fader: -4 },
    pad: { track: 'Pad', patch: 'Warm Pad', pattern: 'factory-pad-long', preset: 'pad-wash', fader: 6 },
    // Deep house sits in a dark, damped space; the dotted-8th dub echo on the keys.
    reverb: 'dark', delay: 'delay-dub', master: 'master-warm',
  },
  {
    id: 'garage-130', name: 'Garage 130', tempo: 130, key: { root: 5, scale: 'minor' }, kit: 'garage',
    blurb: 'Skipping 2-step drums, a sub bass and a stabbing organ, in F minor',
    drums: { intro: 'factory-minimal', groove: 'factory-garage-2-step', fill: 'factory-fill-a', preset: 'kick-punch', fader: -4, sends: { a: -24 } },
    bass: { track: 'Bass', patch: 'Sub Bass', pattern: 'factory-garage-sub', preset: 'bass-tidy', fader: 1.5 },
    chords: { track: 'Organ', patch: 'Garage Organ', pattern: 'factory-garage-organ', preset: 'stab-space', fader: -5 },
    // A bright plate on the snare and organ; eighths bouncing left-right.
    reverb: 'plate', delay: 'delay-pingpong', master: 'master-clean',
  },
  {
    id: 'acid-126', name: 'Acid 126', tempo: 126, key: A_MINOR, kit: 'drum-machine',
    blurb: 'A 909-ish classic house groove, a 303 line and an M1 organ stab, in A minor',
    drums: { intro: 'factory-four-on-the-floor', groove: 'factory-classic-house', fill: 'factory-fill-a', preset: 'kick-punch', fader: -5, sends: { a: -26 } },
    // The acid line is the lead: a dub echo under it, as the classic records have.
    bass: { track: 'Acid', patch: 'Acid Line', pattern: 'factory-acid-303-line', preset: 'bass-tidy', fader: 6, sends: { b: -20 } },
    chords: { track: 'Stab', patch: 'Piano Stab', pattern: 'factory-classic-m1-stab', preset: 'stab-space', fader: -6 },
    reverb: 'room', delay: 'delay-dub', master: 'master-clean',
  },
  {
    id: 'tech-house-125', name: 'Tech House 125', tempo: 125, key: { root: 7, scale: 'minor' }, kit: 'drum-machine',
    blurb: 'Tight drums, a rolling Reese, a dub brass chord and strings, in G minor',
    drums: { intro: 'factory-minimal', groove: 'factory-tech-house', fill: 'factory-fill-a', preset: 'kick-punch', fader: -5, sends: { a: -28 } },
    bass: { track: 'Bass', patch: 'Reese Bass', pattern: 'factory-rolling-16ths', preset: 'bass-tidy', fader: 6 },
    // Dub chord's echoes are written a dotted 8th apart: more of the 3/16 delay thickens them.
    chords: { track: 'Stab', patch: 'Brass Stab', pattern: 'factory-dub-chord', preset: 'stab-space', fader: -4, sends: { b: -10 } },
    pad: { track: 'Strings', patch: 'Strings', pattern: 'factory-pad-long', preset: 'pad-wash', fader: 4 },
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

/** Strip preset, then the fader and send levels. */
function mix(p: Project, t: Template, trackId: string, strip: PartStrip) {
  if (!applyPreset(p, NO_ENGINE, trackId, strip.preset)) fail(t, `preset "${strip.preset}" didn't apply`);
  setMix(p, NO_ENGINE, trackId, 'fader', strip.fader);
  if (strip.sends?.a !== undefined) setMix(p, NO_ENGINE, trackId, 'send_a', strip.sends.a);
  if (strip.sends?.b !== undefined) setMix(p, NO_ENGINE, trackId, 'send_b', strip.sends.b);
}

/** A synth part's track: its patch, its (transposed) factory pattern, its strip; null for an absent part. */
function synthPart(p: Project, t: Template, part: SynthPart, shift: number) {
  const patch = BUILTIN_PATCHES.find((x) => x.name === part.patch) ?? fail(t, `no patch "${part.patch}"`);
  const track = addSynthTrack(p, NO_ENGINE, part.track, patch) ?? fail(t, `no room for ${part.track}`);
  const first = currentPattern(track).id;
  const main = loadPattern(p, t, track, part.pattern, shift);
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
