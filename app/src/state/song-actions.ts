// Song timeline edits: clips, mode, loop and seek. Like actions.ts: every
// function mutates Project AND sends the matching engine command.
//
// Clips: each track has up to MAX_CLIPS; `clip.idx` is the engine clip slot
// (lowest free, like note idx). CLIP_SET packs `b = offset * 16 + engineIdx`
// of the clip's pattern (a pattern of the same track). A clip lies inside
// 0..MAX_SONG_TICKS, len >= 1, offset 0..MAX_OFFSET; invalid edits are refused
// (null/false), except moveClips, which clamps the group's time delta so the
// whole selection stays in the song. Snapping is the UI's job, not done here.
import { MAX_CLIPS, MAX_SONG_TICKS, Op } from '../audio/protocol';
import { patternLength } from './project.svelte';
import type { Clip, Project, Track } from './project.svelte';
import type { CommandSink } from './actions';
import { copyPattern, patternOf } from './pattern-actions';
import { edit } from './edits';

/** Largest clip offset into its pattern (16 bars - 1 tick, the engine limit). */
export const MAX_OFFSET = 61439;

const findTrack = (p: Project, trackId: string): Track | null => p.tracks.find((t) => t.id === trackId) ?? null;

/** Every clip in `ids` that exists, with its track, in `ids` order; repeated ids count once. */
function findClips(p: Project, ids: string[]): { t: Track; c: Clip }[] {
  const out: { t: Track; c: Clip }[] = [];
  for (const id of new Set(ids)) {
    for (const t of p.tracks) {
      const c = t.clips.find((x) => x.id === id);
      if (c) {
        out.push({ t, c });
        break;
      }
    }
  }
  return out;
}

const valid = (start: number, len: number, offset: number) =>
  Number.isFinite(start) && Number.isFinite(len) && Number.isFinite(offset) &&
  start >= 0 && len >= 1 && start + len <= MAX_SONG_TICKS && offset >= 0 && offset <= MAX_OFFSET;

function freeClipIdx(t: Track): number | null {
  const used = new Set(t.clips.map((c) => c.idx));
  for (let i = 0; i < MAX_CLIPS; i++) if (!used.has(i)) return i;
  return null;
}

/** CLIP_SET for clip `c` of track `t` (also used by project load). */
export function sendClip(sink: CommandSink, t: Track, c: Clip) {
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

/**
 * Moves clips by `dTicks`, clamped so the group stays in 0..MAX_SONG_TICKS.
 * Lane moves (`dLane` != 0) are refused (false, nothing moves) for now:
 * patterns belong to tracks and the engine cannot copy one across tracks, so
 * any mapping would silently change what the clip plays (ruling R4). The
 * parameter stays so the timeline can call it; a real cross-track pattern
 * copy can enable it later (same-kind lanes only).
 */
export function moveClips(p: Project, sink: CommandSink, ids: string[], dTicks: number, dLane = 0): boolean {
  return edit(p, 'Move clips', () => {
    const found = findClips(p, ids);
    if (!found.length || !Number.isFinite(dTicks) || dLane !== 0) return false;
    const minStart = Math.min(...found.map(({ c }) => c.start));
    const maxEnd = Math.max(...found.map(({ c }) => c.start + c.len));
    const dt = Math.min(MAX_SONG_TICKS - maxEnd, Math.max(-minStart, Math.round(dTicks)));
    if (dt === 0) return true;
    for (const { t, c } of found) {
      c.start += dt;
      sendClip(sink, t, c);
    }
    return true;
  });
}

/** Sets any of start/len/offset (rounded). False (nothing changes) when the result is invalid. */
export function resizeClip(
  p: Project, sink: CommandSink, id: string, o: { start?: number; len?: number; offset?: number },
): boolean {
  return edit(p, 'Resize clip', () => {
    const [f] = findClips(p, [id]);
    if (!f) return false;
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
      t.clips.splice(t.clips.indexOf(c), 1);
    }
  });
}

/** Each copy goes right after its source (same lane, pattern, length, offset). Copies that do not fit are skipped. */
export function duplicateClips(p: Project, sink: CommandSink, ids: string[]): Clip[] {
  return edit(p, 'Duplicate clips', () => {
    const out: Clip[] = [];
    for (const { t, c } of findClips(p, ids)) {
      const copy = addClip(p, sink, t.id, { start: c.start + c.len, len: c.len, patternId: c.patternId, offset: c.offset });
      if (copy) out.push(copy);
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
export function patternPosAt(t: Track, patternId: string, songTick: number): number | null {
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
