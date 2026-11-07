// Audio tracks and audio clips (plan 9; spec addendum §3.1). Like
// actions.ts: every function mutates Project AND sends the matching engine
// command, inside edit() (one undo step).
//
// One audio-clip edit is always three commands (sendAudioClip): SOURCE
// (sample, offset seconds, loop) and GAIN (linear gain, fades) only stage
// the change in the engine; SET (start, len) commits both, so the audio
// thread never plays a half-applied edit. Load, undo and export use the same
// encoding (project/commands.ts audioClipCommands).
//
// Units: start / len / fades are song ticks; `offset` is seconds into the
// file (the project stays sample-rate independent; the engine converts);
// `gain` is dB, CLIP_GAIN_MIN_DB meaning -inf (silence, linear 0). A file's
// length in ticks depends on the tempo (Project.sampleMeta seconds × ticks
// per second): clips play at native speed, so a tempo change keeps a clip's
// length in ticks and only moves where its audio ends.
//
// Moving, resizing, splitting, duplicating and deleting go through
// song-actions.ts (moveClips, resizeClip, splitClips, ...), which handle
// both clip kinds and call into the helpers here for audio clips.
import { BAR_TICKS, MAX_CLIPS, MAX_CLIP_GAIN, MAX_SAMPLE_FLOATS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { MAX_SAMPLES, MAX_TRACKS, TRACK_COLORS, newChannel } from './project.svelte';
import type { AudioClip, AudioTrack, Project, Track } from './project.svelte';
import { selectTrack, uniqueTrackName } from './actions';
import type { CommandSink } from './actions';
import { edit } from './edits';

/** The quietest clip gain, shown as "-inf": linear 0 (like the fader's minimum). */
export const CLIP_GAIN_MIN_DB = -60;
/** The loudest clip gain: +12 dB (MAX_CLIP_GAIN = 4 linear in the engine). */
export const CLIP_GAIN_MAX_DB = 12;
/**
 * Largest clip offset in seconds: a sanity bound only (the engine refuses an
 * offset past MAX_SAMPLE_FLOATS frames at its rate; real offsets lie inside
 * their file, which is at most that long).
 */
export const MAX_AUDIO_OFFSET = MAX_SAMPLE_FLOATS / 48000;

/** dB -> the engine's linear clip gain (0..MAX_CLIP_GAIN; the minimum is silence). */
export function clipGainLinear(db: number): number {
  if (!(db > CLIP_GAIN_MIN_DB)) return 0;
  return Math.min(MAX_CLIP_GAIN, 10 ** (Math.min(db, CLIP_GAIN_MAX_DB) / 20));
}

/** Song ticks per second at `tempo` BPM (960 per beat). */
export const ticksPerSecond = (tempo: number) => (tempo / 60) * (BAR_TICKS / 4);

/** Seconds of sample `id` (Project.sampleMeta), or null when unknown. */
export const fileSeconds = (p: Project, id: number | null): number | null =>
  id === null ? null : (p.sampleMeta.get(id)?.seconds ?? null);

/** Lowest free engine clip slot of `t` (any kind), or null at MAX_CLIPS. */
export function freeClipIdx(t: Track): number | null {
  const used = new Set(t.clips.map((c) => c.idx));
  for (let i = 0; i < MAX_CLIPS; i++) if (!used.has(i)) return i;
  return null;
}

/** The audio clip `id` with its track, or null. */
export function findAudioClip(p: Project, id: string): { t: AudioTrack; c: AudioClip } | null {
  for (const t of p.tracks) {
    if (t.kind !== 'audio') continue;
    const c = t.clips.find((x) => x.id === id);
    if (c) return { t, c };
  }
  return null;
}

/** SOURCE, GAIN, then SET for clip `c` of `t`: the one encoding (edits, load, undo, export). */
export function sendAudioClip(sink: CommandSink, t: AudioTrack, c: AudioClip) {
  const at = t.slot * MAX_CLIPS + c.idx;
  sink.send(Op.AUDIO_CLIP_SOURCE, at, c.sampleId ?? -1, c.offset, c.loop ? 1 : 0);
  sink.send(Op.AUDIO_CLIP_GAIN, at, clipGainLinear(c.gain), c.fadeIn, c.fadeOut);
  sink.send(Op.AUDIO_CLIP_SET, at, c.start, c.len);
}

/** A new Audio track at the lowest free slot (selected). Null when all MAX_TRACKS slots are taken. */
export function addAudioTrack(p: Project, sink: CommandSink, o: { name?: string } = {}): AudioTrack | null {
  return edit(p, 'Add audio track', () => {
    const used = new Set(p.tracks.map((t) => t.slot));
    let slot = 0;
    while (slot < MAX_TRACKS && used.has(slot)) slot++;
    if (slot >= MAX_TRACKS) return null;
    p.tracks.push({
      kind: 'audio',
      id: crypto.randomUUID(),
      slot,
      name: o.name ?? uniqueTrackName(p, 'Audio'),
      color: TRACK_COLORS[slot % TRACK_COLORS.length],
      clips: [],
    });
    const track = p.tracks[p.tracks.length - 1] as AudioTrack; // reactive proxy
    // The engine resets the mixer slot on ADD; mirror it with default state.
    p.mixer.channels[track.id] = newChannel();
    sink.send(Op.ADD_AUDIO_TRACK, slot);
    selectTrack(p, sink, track.id);
    return track;
  });
}

type ClipFields = Omit<AudioClip, 'id' | 'idx'>;

/**
 * `want` made valid, or null when it cannot be (start/len outside the song,
 * a bad offset, gain or sample). Rounds ticks, clamps the gain to its range,
 * wraps a loop clip's offset into its file, shortens fades that do not fit
 * the clip, and with `capLen` stops a one-shot clip's right edge at the end
 * of its file at the current tempo (when the file length is known).
 */
function normalize(p: Project, want: ClipFields, capLen: boolean): ClipFields | null {
  const start = Math.round(want.start);
  let len = Math.round(want.len);
  const { sampleId, loop } = want;
  let offset = want.offset;
  if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len < 1 || start + len > MAX_SONG_TICKS) return null;
  if (!Number.isFinite(offset) || offset < 0 || offset > MAX_AUDIO_OFFSET) return null;
  if (Number.isNaN(want.gain) || typeof loop !== 'boolean') return null;
  if (sampleId !== null && !(Number.isInteger(sampleId) && sampleId >= 0 && sampleId < MAX_SAMPLES)) return null;
  const seconds = fileSeconds(p, sampleId);
  if (loop && seconds && offset >= seconds) offset %= seconds; // the same position: the file repeats
  if (capLen && !loop && seconds !== null) {
    len = Math.min(len, Math.max(1, Math.ceil((seconds - offset) * ticksPerSecond(p.tempo) - 1e-9)));
  }
  const gain = Math.min(CLIP_GAIN_MAX_DB, Math.max(CLIP_GAIN_MIN_DB, want.gain));
  const fadeOut = Math.min(len, Math.max(0, Math.round(want.fadeOut) || 0));
  const fadeIn = Math.min(len - fadeOut, Math.max(0, Math.round(want.fadeIn) || 0));
  return { sampleId, start, len, offset, loop, gain, fadeIn, fadeOut };
}

const sameFields = (a: ClipFields, b: ClipFields) =>
  a.sampleId === b.sampleId && a.start === b.start && a.len === b.len && a.offset === b.offset &&
  a.loop === b.loop && a.gain === b.gain && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;

/** Applies `next` (normalized) to `c` and sends it; nothing when unchanged. */
function apply(sink: CommandSink, t: AudioTrack, c: AudioClip, next: ClipFields) {
  if (sameFields(c, next)) return; // drags re-send often
  Object.assign(c, next);
  sendAudioClip(sink, t, c);
}

/**
 * Places a clip of sample `sampleId` (null: "missing sample") at `start` on
 * Audio track `trackId`. The length defaults to the file's length at the
 * current tempo (one bar when it is not known) and is cut to fit the song;
 * the other fields default to offset 0, no loop, 0 dB, no fades. Null when
 * the track is not an Audio track, the start is outside the song, a value is
 * invalid, or the track has MAX_CLIPS clips.
 */
export function addAudioClip(
  p: Project, sink: CommandSink, trackId: string,
  o: { sampleId: number | null; start: number } & Partial<Omit<ClipFields, 'sampleId' | 'start'>>,
): AudioClip | null {
  return edit(p, 'Add audio clip', () => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || t.kind !== 'audio') return null;
    const start = Math.round(o.start);
    if (!(start >= 0 && start < MAX_SONG_TICKS)) return null;
    const seconds = fileSeconds(p, o.sampleId);
    const fileLen = seconds !== null ? Math.max(1, Math.round(seconds * ticksPerSecond(p.tempo))) : BAR_TICKS;
    const len = Math.min(MAX_SONG_TICKS - start, o.len ?? fileLen);
    const f = normalize(p, {
      sampleId: o.sampleId, start, len, offset: o.offset ?? 0, loop: o.loop ?? false,
      gain: o.gain ?? 0, fadeIn: o.fadeIn ?? 0, fadeOut: o.fadeOut ?? 0,
    }, o.len !== undefined);
    const idx = freeClipIdx(t);
    if (!f || idx === null) return null;
    t.clips.push({ id: crypto.randomUUID(), idx, ...f });
    const c = t.clips[t.clips.length - 1]; // reactive proxy
    sendAudioClip(sink, t, c);
    return c;
  });
}

/**
 * Sets any clip fields. False (nothing changes) when the clip is unknown or
 * the result is invalid (see normalize: ticks rounded, gain clamped to
 * -inf..+12 dB, fades shortened to fit). A one-shot clip's new `len` stops
 * at the end of its file at the current tempo; a loop clip can be any
 * length. Moving `start` alone moves the clip (trimAudioClipStart trims).
 */
export function setAudioClip(p: Project, sink: CommandSink, id: string, partial: Partial<ClipFields>): boolean {
  return edit(p, 'Edit audio clip', () => {
    const f = findAudioClip(p, id);
    if (!f) return false;
    const { c } = f;
    const want: ClipFields = {
      sampleId: c.sampleId, start: c.start, len: c.len, offset: c.offset, loop: c.loop,
      gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut, ...partial,
    };
    const next = normalize(p, want, partial.len !== undefined);
    if (!next) return false;
    apply(sink, f.t, c, next);
    return true;
  });
}

/**
 * Left-edge trim to `start` (rounded): the end stays and the offset moves
 * with the start, so the audio stays where it was in the song. A one-shot
 * clip cannot start before its file (offset 0); a loop clip wraps around
 * its file. Clamped to leave at least one tick. False for an unknown clip.
 */
export function trimAudioClipStart(p: Project, sink: CommandSink, id: string, start: number): boolean {
  return edit(p, 'Trim audio clip', () => {
    const f = findAudioClip(p, id);
    if (!f || !Number.isFinite(start)) return false;
    const { t, c } = f;
    const tps = ticksPerSecond(p.tempo);
    const end = c.start + c.len;
    const seconds = fileSeconds(p, c.sampleId);
    const wraps = c.loop && seconds !== null && seconds > 0;
    // Leftmost: song tick 0, and for a one-shot (or unknown-length loop) clip the file's start.
    const first = wraps ? 0 : Math.max(0, Math.ceil(c.start - c.offset * tps - 1e-9));
    const s = Math.min(end - 1, Math.max(first, Math.round(start)));
    let offset = Math.max(0, c.offset + (s - c.start) / tps);
    if (wraps) offset = (((c.offset + (s - c.start) / tps) % seconds!) + seconds!) % seconds!;
    const next = normalize(p, { ...c, start: s, len: end - s, offset }, false);
    if (!next) return false;
    apply(sink, t, c, next);
    return true;
  });
}

/**
 * Internal for song-actions.ts: a copy of `fields` placed on Audio track `t`
 * (a free idx; the UI id given or a new one) and sent. Null when `t` is full
 * or the fields are invalid. Not an edit() of its own: the caller's is.
 */
export function placeAudioClip(p: Project, sink: CommandSink, t: AudioTrack, fields: ClipFields, id: string = crypto.randomUUID()): AudioClip | null {
  const f = normalize(p, fields, false);
  const idx = freeClipIdx(t);
  if (!f || idx === null) return null;
  t.clips.push({ id, idx, ...f });
  const c = t.clips[t.clips.length - 1];
  sendAudioClip(sink, t, c);
  return c;
}

/** Internal for song-actions.ts: set a clip's fields (normalized, no cap) and send; false if invalid. */
export function updateAudioClip(p: Project, sink: CommandSink, t: AudioTrack, c: AudioClip, partial: Partial<ClipFields>): boolean {
  const next = normalize(p, { ...c, ...partial }, false);
  if (!next) return false;
  apply(sink, t, c, next);
  return true;
}
