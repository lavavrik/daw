// Song timeline edits: clips, mode, loop and seek. Like actions.ts: every
// function mutates Project AND sends the matching engine command.
//
// Clips: each track has up to MAX_CLIPS; `clip.idx` is the engine clip slot
// (lowest free, like note idx). CLIP_SET packs `b = offset * 16 + engineIdx`
// of the clip's pattern (a pattern of the same track). A clip lies inside
// 0..MAX_SONG_TICKS, len >= 1, offset 0..MAX_OFFSET; invalid edits are refused
// (null/false), except moveClips, which clamps the group's time delta so the
// whole selection stays in the song. Snapping is the UI's job, not done here.
//
// Audio clips (plan 9, Audio tracks) are clips too: moveClips, resizeClip,
// deleteClips, duplicateClips and splitClips take ids of either kind and
// send an audio clip as SOURCE, GAIN, SET (audio-actions.ts sendAudioClip).
// Unlike note clips, audio clips may move between Audio lanes (they have no
// pattern); `offset` is seconds for them.
import { MAX_CLIPS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { isPatternTrack, patternLength } from './project.svelte';
import type { AudioClip, AudioTrack, Clip, PatternTrack, Project } from './project.svelte';
import type { CommandSink } from './actions';
import { copyPattern, patternOf } from './pattern-actions';
import { edit } from './edits';
import {
  MAX_AUDIO_OFFSET, fileSeconds, freeClipIdx, placeAudioClip, sendAudioClip, setAudioClip, ticksPerSecond, updateAudioClip,
} from './audio-actions';

/** Largest clip offset into its pattern (16 bars - 1 tick, the engine limit). */
export const MAX_OFFSET = 61439;

/** The drum or synth track `trackId` (pattern clips only go there). */
const findTrack = (p: Project, trackId: string): PatternTrack | null => {
  const t = p.tracks.find((x) => x.id === trackId);
  return t && isPatternTrack(t) ? t : null;
};

/** A clip with its track: a pattern clip, or an audio clip (`audio` true). */
type Found = { audio: false; t: PatternTrack; c: Clip } | { audio: true; t: AudioTrack; c: AudioClip };

/** Every clip in `ids` that exists, with its track, in `ids` order; repeated ids count once. */
function findClips(p: Project, ids: string[]): Found[] {
  const out: Found[] = [];
  for (const id of new Set(ids)) {
    for (const t of p.tracks) {
      if (t.kind === 'audio') {
        const c = t.clips.find((x) => x.id === id);
        if (c) {
          out.push({ audio: true, t, c });
          break;
        }
      } else {
        const c = t.clips.find((x) => x.id === id);
        if (c) {
          out.push({ audio: false, t, c });
          break;
        }
      }
    }
  }
  return out;
}

const valid = (start: number, len: number, offset: number) =>
  Number.isFinite(start) && Number.isFinite(len) && Number.isFinite(offset) &&
  start >= 0 && len >= 1 && start + len <= MAX_SONG_TICKS && offset >= 0 && offset <= MAX_OFFSET;

/** CLIP_SET for clip `c` of track `t` (also used by project load). */
export function sendClip(sink: CommandSink, t: PatternTrack, c: Clip) {
  const pat = patternOf(t, c.patternId)!; // clips only reference patterns of their track
  sink.send(Op.CLIP_SET, t.slot * MAX_CLIPS + c.idx, c.offset * 16 + pat.engineIdx, c.start, c.len);
}

/**
 * Places a clip on the track's lane. Defaults: the current pattern, its length,
 * offset 0. Values are rounded to ticks. Null when invalid (range, pattern not
 * on this track) or the track has MAX_CLIPS clips.
 */
export function addClip(
  p: Project, sink: CommandSink, trackId: string,
  o: { start: number; len?: number; patternId?: string; offset?: number },
): Clip | null {
  return edit(p, 'Add clip', () => {
    const t = findTrack(p, trackId);
    const pat = t && patternOf(t, o.patternId ?? t.currentPatternId);
    if (!t || !pat) return null;
    const start = Math.round(o.start);
    const len = Math.round(o.len ?? patternLength(pat));
    const offset = Math.round(o.offset ?? 0);
    if (!valid(start, len, offset)) return null;
    const idx = freeClipIdx(t);
    if (idx === null) return null;
    t.clips.push({ id: crypto.randomUUID(), idx, patternId: pat.id, start, len, offset });
    const c = t.clips[t.clips.length - 1]; // reactive proxy
    sendClip(sink, t, c);
    return c;
  });
}

/** Sends clip `f.c` as it is now (CLIP_SET, or SOURCE/GAIN/SET). */
const resend = (sink: CommandSink, f: Found) => (f.audio ? sendAudioClip(sink, f.t, f.c) : sendClip(sink, f.t, f.c));

/**
 * Moves clips by `dTicks`, clamped so the group stays in 0..MAX_SONG_TICKS,
 * and by `dLane` lanes (positions in the track list). False (nothing moves)
 * when the move is refused.
 *
 * Lane moves: audio clips move onto Audio lanes only, each re-homed with
 * CLIP_REMOVE on its old track and the lowest free idx on the new one (its
 * UI id kept); refused when a target is not an Audio track, does not exist
 * or has no free slot. Note clips never change lanes (ruling R4): patterns
 * belong to tracks and the engine cannot copy one across tracks, so any
 * mapping would silently change what the clip plays. A selection with a
 * note clip therefore refuses every lane move.
 */
export function moveClips(p: Project, sink: CommandSink, ids: string[], dTicks: number, dLane = 0): boolean {
  return edit(p, 'Move clips', () => {
    const found = findClips(p, ids);
    if (!found.length || !Number.isFinite(dTicks) || !Number.isInteger(dLane)) return false;
    // Where each clip goes; all checked before anything changes.
    const target = new Map<Found, AudioTrack>();
    if (dLane !== 0) {
      const need = new Map<AudioTrack, number>();
      for (const f of found) {
        const to = p.tracks[p.tracks.indexOf(f.t) + dLane];
        if (!f.audio || !to || to.kind !== 'audio') return false;
        target.set(f, to);
        need.set(to, (need.get(to) ?? 0) + 1);
      }
      for (const [to, n] of need) {
        const leaving = found.filter((f) => f.t === to).length;
        if (to.clips.length - leaving + n > MAX_CLIPS) return false;
      }
    }
    const minStart = Math.min(...found.map(({ c }) => c.start));
    const maxEnd = Math.max(...found.map(({ c }) => c.start + c.len));
    const dt = Math.min(MAX_SONG_TICKS - maxEnd, Math.max(-minStart, Math.round(dTicks)));
    if (dt === 0 && dLane === 0) return true;
    if (dLane === 0) {
      for (const f of found) {
        f.c.start += dt;
        resend(sink, f);
      }
      return true;
    }
    // Every removal first, so a slot freed on one track can take a clip coming in.
    for (const f of found) {
      sink.send(Op.CLIP_REMOVE, f.t.slot * MAX_CLIPS + f.c.idx);
      f.t.clips.splice(f.t.clips.indexOf(f.c as never), 1);
    }
    for (const f of found) {
      const c = f.c as AudioClip;
      placeAudioClip(p, sink, target.get(f)!, { ...c, start: c.start + dt }, c.id);
    }
    return true;
  });
}

/**
 * Sets any of start/len/offset (rounded). False (nothing changes) when the
 * result is invalid. For an audio clip `offset` is seconds and it goes
 * through setAudioClip (a one-shot's new length stops at its file's end).
 */
export function resizeClip(
  p: Project, sink: CommandSink, id: string, o: { start?: number; len?: number; offset?: number },
): boolean {
  return edit(p, 'Resize clip', () => {
    const [f] = findClips(p, [id]);
    if (!f) return false;
    if (f.audio) return setAudioClip(p, sink, id, o);
    const { t, c } = f;
    const start = o.start !== undefined ? Math.round(o.start) : c.start;
    const len = o.len !== undefined ? Math.round(o.len) : c.len;
    const offset = o.offset !== undefined ? Math.round(o.offset) : c.offset;
    if (!valid(start, len, offset)) return false;
    if (start === c.start && len === c.len && offset === c.offset) return true; // drags re-send often
    c.start = start;
    c.len = len;
    c.offset = offset;
    sendClip(sink, t, c);
    return true;
  });
}

/** Unknown ids are skipped. */
export function deleteClips(p: Project, sink: CommandSink, ids: string[]) {
  return edit(p, 'Delete clips', () => {
    for (const { t, c } of findClips(p, ids)) {
      sink.send(Op.CLIP_REMOVE, t.slot * MAX_CLIPS + c.idx);
      t.clips.splice(t.clips.indexOf(c as never), 1);
    }
  });
}

/** Each copy goes right after its source (same lane, pattern or sample, length, offset, ...). Copies that do not fit are skipped. */
export function duplicateClips(p: Project, sink: CommandSink, ids: string[]): (Clip | AudioClip)[] {
  return edit(p, 'Duplicate clips', () => {
    const out: (Clip | AudioClip)[] = [];
    for (const f of findClips(p, ids)) {
      const { c } = f;
      const copy = f.audio
        ? placeAudioClip(p, sink, f.t, { ...f.c, start: c.start + c.len })
        : addClip(p, sink, f.t.id, { start: c.start + c.len, len: c.len, patternId: f.c.patternId, offset: f.c.offset });
      if (copy) out.push(copy);
    }
    return out;
  });
}

/**
 * Splits every clip in `ids` that `tick` (rounded) falls strictly inside:
 * the clip keeps its id and ends at `tick`; a new clip on the same lane
 * plays on from there, its offset moved on by the left half's length (note
 * clip: ticks, wrapped into the pattern; audio clip: seconds at the current
 * tempo, wrapped into the file for a loop clip). An audio clip's fade-in
 * stays on the left half and its fade-out goes to the right one. A clip
 * whose track has no free slot is left whole. Returns the new right halves.
 */
export function splitClips(p: Project, sink: CommandSink, ids: string[], tick: number): (Clip | AudioClip)[] {
  return edit(p, 'Split clips', () => {
    const out: (Clip | AudioClip)[] = [];
    const at = Math.round(tick);
    if (!Number.isFinite(at)) return out;
    for (const f of findClips(p, ids)) {
      const { c } = f;
      const d = at - c.start;
      const end = c.start + c.len;
      if (d <= 0 || at >= end || freeClipIdx(f.t) === null) continue;
      if (f.audio) {
        const left = f.c;
        const seconds = fileSeconds(p, left.sampleId);
        let offset = left.offset + d / ticksPerSecond(p.tempo);
        if (left.loop && seconds) offset %= seconds;
        if (offset > MAX_AUDIO_OFFSET) continue; // could not be placed: leave it whole
        const fadeOut = left.fadeOut;
        updateAudioClip(p, sink, f.t, left, { len: d, fadeOut: 0 });
        const right = placeAudioClip(p, sink, f.t, { ...left, start: at, len: end - at, offset, fadeIn: 0, fadeOut });
        if (right) out.push(right);
      } else {
        const pat = patternOf(f.t, f.c.patternId)!;
        const offset = (f.c.offset + d) % patternLength(pat);
        f.c.len = d;
        sendClip(sink, f.t, f.c);
        const right = addClip(p, sink, f.t.id, { start: at, len: end - at, patternId: f.c.patternId, offset });
        if (right) out.push(right);
      }
    }
    return out;
  });
}

/**
 * Detaches one clip: copies its pattern (COPY_PATTERN, see copyPattern) and
 * points the clip at the copy, so later edits of either do not affect the
 * other. The current pattern does not change. Null when unknown or full.
 */
export function makeUnique(p: Project, sink: CommandSink, trackId: string, clipId: string) {
  return edit(p, 'Make unique', () => {
    const t = findTrack(p, trackId);
    const c = t?.clips.find((x) => x.id === clipId);
    if (!t || !c) return null;
    const pat = copyPattern(p, sink, t.id, c.patternId);
    if (!pat) return null;
    c.patternId = pat.id;
    sendClip(sink, t, c);
    return pat;
  });
}

/** SET_MODE; entering Song mode also sends SEEK to the parked song position. */
export function setMode(p: Project, sink: CommandSink, mode: 'pattern' | 'song') {
  return edit(p, mode === 'song' ? 'Song mode' : 'Pattern mode', () => {
    if (p.mode === mode || (mode !== 'pattern' && mode !== 'song')) return;
    p.mode = mode;
    sink.send(Op.SET_MODE, mode === 'song' ? 1 : 0);
    if (mode === 'song') sink.send(Op.SEEK, p.songPosition);
  });
}

/**
 * Updates any of on/start/end (ticks, rounded). Needs 0 <= start < end <=
 * MAX_SONG_TICKS, else false. Sends SET_LOOP(start, end) while on and
 * SET_LOOP(0, 0) (disabled) while off; the range is kept either way.
 */
export function setLoop(p: Project, sink: CommandSink, o: { on?: boolean; start?: number; end?: number }): boolean {
  return edit(p, 'Loop', () => {
    const on = o.on ?? p.loop.on;
    const start = o.start !== undefined ? Math.round(o.start) : p.loop.start;
    const end = o.end !== undefined ? Math.round(o.end) : p.loop.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > MAX_SONG_TICKS || start >= end) return false;
    p.loop = { on, start, end };
    if (on) sink.send(Op.SET_LOOP, start, end);
    else sink.send(Op.SET_LOOP, 0, 0);
    return true;
  });
}

/** Song position (clamped, rounded; NaN ignored). The engine ignores SEEK in Pattern mode; setMode re-sends it. */
export function seek(p: Project, sink: CommandSink, ticks: number) {
  if (!Number.isFinite(ticks)) return;
  p.songPosition = Math.min(MAX_SONG_TICKS, Math.max(0, Math.round(ticks)));
  sink.send(Op.SEEK, p.songPosition);
}

/**
 * Where inside pattern `patternId` the song is at `songTick`, for the playheads:
 * the position (ticks, 0..pattern length) of the clip of that pattern playing
 * on this track, or null when none is. Same mapping as the engine:
 * (offset + tick - start) mod pattern length. Where clips overlap, the one that
 * started latest wins (the editor shows one playhead).
 */
export function patternPosAt(t: PatternTrack, patternId: string, songTick: number): number | null {
  const pat = patternOf(t, patternId);
  if (!pat || !Number.isFinite(songTick)) return null;
  let best: Clip | null = null;
  for (const c of t.clips) {
    if (c.patternId !== patternId || songTick < c.start || songTick >= c.start + c.len) continue;
    if (!best || c.start > best.start) best = c;
  }
  if (!best) return null;
  const len = patternLength(pat);
  return (((best.offset + songTick - best.start) % len) + len) % len;
}
