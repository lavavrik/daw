<script lang="ts">
  // The Acid tab (plan 17, spec addendum §2): the synth track's current
  // pattern shown as steps, 16 per row (1..4 bars). There is no stored step
  // format: the steps are read from the pattern's notes (state/acidSteps.ts
  // readSteps) and every edit is written back as notes (state/acid-actions.ts
  // applyAcidSteps, one undo entry each). docs/architecture/sequencer.md,
  // "Acid tab", has the mapping and the rewrite rule.
  //
  // View state, never saved: the base octave (a MIDI C, default 36 = C2), the
  // selected step, and the Randomize root/scale (default A minor). When the
  // pattern only reads at another base (readSteps auto-fits the lowest note),
  // that base is adopted, and every edit passes the base the steps were read
  // at, so applyAcidSteps never refuses a view the tab shows.
  //
  // Step entry: with a step selected, every live note-on (QWERTY piano or
  // MIDI; input/lastNote lastLive.seq) sets that step's pitch and selects the
  // next step. The note still sounds. The tab is only mounted while it is
  // shown (BottomPanel), so "the tab is visible" needs no extra check. Not
  // while the recorder captures (armed and playing): the note is recorded,
  // and entering it as a step too would write it twice.
  //
  // KEYBOARD FOCUS RULE (like the piano roll): while focus is inside the tab
  // and a step is selected, ← → ↑ ↓ move the selection (↑ ↓ by a row),
  // Shift+A accent, Shift+S slide, Shift+R rest, Shift+T tie, Delete or
  // Backspace rest, Escape deselects; exactly those keys are stopped here.
  // Plain letters are QWERTY piano keys (A = C, S = D, T = F#…) and must reach
  // input/shortcuts.ts so step entry works for every piano key. The piano
  // ignores Shift, so the four Shift combos are stopped (Shift+R would also
  // toggle record arm there). Without
  // a selection only the arrows (select step 1) are taken. Space, Z/X, R,
  // undo and every other key bubble on to input/shortcuts.ts.
  //
  // Key strip: a click sets the selected step's pitch and auditions it (a
  // 150 ms note through the same live-note bus as the QWERTY piano, ended
  // early by pointerup). That note-on is marked as seen, so it doesn't also
  // enter a step.
  //
  // Undo: each edit is one entry. Keyboard and step-entry edits of one kind
  // merge (coalesce key acid:<track>:<kind>, new entry after 1 s idle). A
  // click is a pointer gesture (history/gestures.ts), which is always its own
  // entry, so clicked edits never merge.
  import { untrack } from 'svelte';
  import { mod } from '../../audio/audioClock';
  import type { AudioClock } from '../../audio/audioClock';
  import { moduleDef, paramIndex } from '../../audio/catalog';
  import { STEP_TICKS } from '../../audio/protocol';
  import { isTyping } from '../../input/shortcuts';
  import { lastLive } from '../../input/lastNote.svelte';
  import type { NoteInput } from '../../input/noteInput';
  import type { CommandSink } from '../../state/actions';
  import { applyAcidSteps, convertToSteps, transposeAcid, type AcidEditKind } from '../../state/acid-actions';
  import { DEFAULT_BASE, MAX_BASE, MIN_BASE, readSteps, REST, stepPitch, type AcidStep, type Unshowable } from '../../state/acidSteps';
  import { mutate, randomize, SCALES, shift, type ScaleName } from '../../state/acidTools';
  import { setPatternBars } from '../../state/pattern-actions';
  import { currentPattern } from '../../state/project.svelte';
  import type { Project, SynthTrack } from '../../state/project.svelte';
  import { patternPosAt } from '../../state/song-actions';
  import { NOTE_NAMES, noteName } from '../noteName';

  let { p, engine, clock, track, noteInput = null, capturing = () => false }: {
    p: Project;
    engine: CommandSink;
    clock: AudioClock | null;
    track: SynthTrack;
    /** Played-note bus: the key strip auditions through it. */
    noteInput?: NoteInput | null;
    /** True while the recorder captures live notes (armed and playing). */
    capturing?: () => boolean;
  } = $props();

  const ROW = 16;
  /** Length menu (bars); the pattern's current length is added when it isn't one. */
  const LENGTHS = [1, 2, 4];
  const AUDITION_VEL = 100;
  const AUDITION_MS = 150;
  const AUDITION_SOURCE = 'acid';
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const REASON: Record<Unshowable, string> = {
    offgrid: 'a note starts off the 1/16 grid',
    chord: 'two notes start on the same step',
    poly: 'notes overlap',
    range: 'the pitches span more than the three octaves of the steps',
    long: 'the pattern is longer than 4 bars',
  };
  const TRANSPOSE: [number, string][] = [[-12, '−12'], [-1, '−1'], [1, '+1'], [12, '+12']];
  const SLIDE_HINT = 'Slides need a mono patch with glide, e.g. Acid Line';
  const NO_NEXT = 'Slide needs a next note';
  const NO_NOTE = 'Slide: this step has no note';

  let base = $state(DEFAULT_BASE);
  let selected = $state<number | null>(null);
  let root = $state(9); // A
  let scale = $state<ScaleName>('minor');
  let el: HTMLDivElement | undefined = $state();

  const pat = $derived(currentPattern(track));
  // Another pattern (picker, undo): the old selection means nothing there.
  let patId = untrack(() => pat.id);
  $effect(() => {
    const id = pat.id;
    if (id !== patId) {
      patId = id;
      selected = null;
    }
  });
  const view = $derived(readSteps(pat.notes, pat.bars, base));
  // Adopt an auto-fitted base (the pattern doesn't read at ours).
  $effect(() => {
    if (view.ok && view.base !== untrack(() => base)) base = view.base;
  });
  const steps = $derived(view.ok ? view.steps : []);
  /** The selection, if it is still a step of the pattern (bars may have shrunk). */
  const sel = $derived(selected !== null && selected < steps.length ? selected : null);
  const cur = $derived(sel === null ? null : steps[sel]);
  const rows = $derived(Array.from({ length: Math.ceil(steps.length / ROW) }, (_, r) => r));

  // ---- slide hint ------------------------------------------------------------
  // Slides are a legato overlap: they only glide on a mono MIDI In with
  // glide > 0 and glide_mode Legato. Otherwise (or with no MIDI In) one quiet hint.
  const MIDI_IN = moduleDef('midi_in');
  const P_MODE = paramIndex(MIDI_IN, 'mode');
  const P_GLIDE = paramIndex(MIDI_IN, 'glide');
  const P_GMODE = paramIndex(MIDI_IN, 'glide_mode');
  const MONO = MIDI_IN.params[P_MODE].choices.indexOf('Mono');
  const LEGATO = MIDI_IN.params[P_GMODE].choices.indexOf('Legato');
  const slideHint = $derived.by(() => {
    const m = track.modules.find((x) => x.kind === MIDI_IN.kind);
    return !m || m.params[P_MODE] !== MONO || !(m.params[P_GLIDE] > 0) || m.params[P_GMODE] !== LEGATO;
  });

  // ---- writing ---------------------------------------------------------------
  function write(next: AcidStep[], label: string, kind?: AcidEditKind) {
    if (view.ok) applyAcidSteps(p, engine, track.id, view.base, next, label, kind);
  }
  function setStep(i: number, s: AcidStep, label: string, kind: AcidEditKind) {
    const next = steps.slice();
    next[i] = s;
    write(next, label, kind);
  }
  /** Pitch a step gets when it turns into a note: the note sounding before it, else the base C. */
  function prevPitch(i: number): { key: number; oct: -1 | 0 | 1 } {
    for (let j = i - 1; j >= 0; j--) if (steps[j].kind === 'note') return { key: steps[j].key, oct: steps[j].oct };
    return { key: 0, oct: 0 };
  }

  // Toggle availability (the reason doubles as the disabled title).
  const canAccent = $derived(cur?.kind === 'note');
  const canSlide = $derived(sel !== null && cur!.kind !== 'rest' && steps[sel + 1]?.kind === 'note');
  const canTie = $derived(sel !== null && sel > 0 && steps[sel - 1].kind !== 'rest');

  function toggleAccent() {
    if (sel === null || !canAccent) return;
    setStep(sel, { ...cur!, accent: !cur!.accent }, 'Step accent', 'accent');
  }
  function toggleSlide() {
    if (sel === null || !canSlide) return;
    setStep(sel, { ...cur!, slide: !cur!.slide }, 'Step slide', 'slide');
  }
  function toggleRest() {
    if (sel === null) return;
    const s = cur!.kind === 'rest' ? { ...REST, kind: 'note' as const, ...prevPitch(sel) } : REST;
    setStep(sel, s, 'Step kind', 'kind');
  }
  function toggleTie() {
    if (sel === null || !canTie) return;
    const s: AcidStep = cur!.kind === 'tie'
      ? { ...REST, kind: 'note', ...prevPitch(sel), slide: cur!.slide }
      : { ...REST, kind: 'tie', slide: cur!.slide };
    setStep(sel, s, 'Step kind', 'kind');
  }
  function setOct(d: 1 | -1) {
    if (sel === null || cur!.kind !== 'note') return;
    const oct = cur!.oct + d;
    if (oct < -1 || oct > 1) return;
    setStep(sel, { ...cur!, oct: oct as -1 | 0 | 1 }, 'Step octave', 'oct');
  }
  /** A key of the strip: the step becomes a note of that pitch class (octave and accent kept). */
  function setKey(k: number) {
    if (sel === null) return;
    const s = cur!;
    const note = s.kind === 'note';
    setStep(sel, { kind: 'note', key: k, oct: note ? s.oct : 0, accent: note && s.accent, slide: s.slide }, 'Step pitch', 'pitch');
  }

  // ---- key strip audition ------------------------------------------------------
  let audition: { pitch: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Sounds the pitch key `k` gives the selected step (pointerdown on the strip). */
  function auditionKey(k: number) {
    auditionStop();
    // While recording, the audition would be recorded as a note.
    if (!noteInput || sel === null || !view.ok || capturing()) return;
    const pitch = stepPitch(view.base, { ...REST, key: k, oct: cur!.kind === 'note' ? cur!.oct : 0 });
    noteInput.on(pitch, AUDITION_VEL, performance.now(), AUDITION_SOURCE);
    // The click sets the step itself (setKey): this note-on enters nothing.
    seenSeq = lastLive.seq;
    audition = { pitch, timer: setTimeout(auditionStop, AUDITION_MS) };
  }
  function auditionStop() {
    if (!audition) return;
    clearTimeout(audition.timer);
    noteInput?.off(audition.pitch, performance.now(), AUDITION_SOURCE);
    audition = null;
  }
  $effect(() => auditionStop); // unmount: never leave the note on

  // ---- step entry ------------------------------------------------------------
  // The effect's first run (mount) only records the count: notes played
  // before the tab opened enter nothing.
  let seenSeq = untrack(() => lastLive.seq);
  $effect(() => {
    const seq = lastLive.seq;
    if (seq === seenSeq) return;
    seenSeq = seq;
    untrack(() => enter(lastLive.note));
  });
  function enter(note: number | null) {
    if (note === null || sel === null || !view.ok || capturing()) return;
    const i = sel;
    const s = steps[i];
    const oct = Math.max(-1, Math.min(1, Math.floor(note / 12) - view.base / 12)) as -1 | 0 | 1;
    const keep = s.kind === 'note';
    setStep(i, { kind: 'note', key: note % 12, oct, accent: keep && s.accent, slide: s.slide }, 'Enter steps', 'entry');
    selected = (i + 1) % steps.length;
  }

  // ---- tools (never coalesce) --------------------------------------------------
  const empty = $derived(steps.every((s) => s.kind === 'rest'));
  const allNotes = $derived(pat.notes);
  const canTranspose = (semis: number) =>
    allNotes.length > 0 && allNotes.every((n) => n.pitch + semis >= 0 && n.pitch + semis <= 127);
  /** A base the pattern reads at exactly (no auto-fit). */
  const canBase = (b: number) => {
    if (b < MIN_BASE || b > MAX_BASE || !view.ok) return false;
    const v = readSteps(pat.notes, pat.bars, b);
    return v.ok && v.base === b;
  };
  function convert() {
    base = convertToSteps(p, engine, track.id);
  }
  const lengths = $derived(LENGTHS.includes(pat.bars) ? LENGTHS : [...LENGTHS, pat.bars].sort((a, b) => a - b));
  /** The pattern's length (as the piano roll's Length menu): one 'Pattern length' entry. */
  function setLength(bars: number) {
    setPatternBars(p, engine, track.id, bars);
  }

  // ---- selection & keys --------------------------------------------------------
  function pick(i: number) {
    selected = sel === i ? null : i;
  }
  function move(by: number) {
    const n = steps.length;
    if (n === 0) return;
    selected = sel === null ? 0 : (((sel + by) % n) + n) % n;
    // Focus follows when it was on a step, so the next arrow keeps going from there.
    const f = document.activeElement as HTMLElement | null;
    if (f?.dataset.testid?.startsWith('acid-step-')) {
      queueMicrotask(() => el?.querySelector<HTMLElement>(`[data-testid="acid-step-${selected}"]`)?.focus());
    }
  }
  function key(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    if ((e.target as HTMLElement | null)?.tagName === 'SELECT') return; // its own arrows
    if (!view.ok) return;
    const arrows: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -ROW, ArrowDown: ROW };
    if (e.code in arrows) {
      move(arrows[e.code]);
    } else if (sel !== null && e.shiftKey && ['KeyA', 'KeyS', 'KeyR', 'KeyT'].includes(e.code)) {
      // Swallowed even when the toggle is unavailable: the piano ignores
      // Shift, so Shift+A would still play (and enter) a C.
      if (!e.repeat) {
        if (e.code === 'KeyA') toggleAccent();
        else if (e.code === 'KeyS') toggleSlide();
        else if (e.code === 'KeyR') toggleRest();
        else toggleTie();
      }
    } else if (sel !== null && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (!e.repeat) setStep(sel, REST, 'Step kind', 'kind');
    } else if (sel !== null && e.code === 'Escape') {
      selected = null;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- playhead (as StepGrid / PianoRoll: heard position, rAF while playing) ----
  let playStep = $state(-1);
  $effect(() => {
    if (!p.playing || !clock) return;
    const c = clock;
    let raf = 0;
    const loop = () => {
      const t = c.heardTicks();
      // Song mode: t is song time; only a clip of this pattern shows the playhead.
      const pos = !Number.isFinite(t) || t < 0 ? null
        : p.mode === 'song' ? patternPosAt(track, pat.id, t)
        : mod(t, pat.bars * ROW * STEP_TICKS);
      const next = pos === null ? -1 : Math.floor(pos / STEP_TICKS);
      if (next !== playStep) playStep = next;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      playStep = -1;
    };
  });

  function stepLabel(i: number, s: AcidStep) {
    const what = s.kind === 'note' ? noteName(stepPitch(view.ok ? view.base : base, s)) : s.kind;
    return `Step ${i + 1}: ${what}${s.accent ? ', accent' : ''}${s.slide ? ', slide' : ''}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="acid" bind:this={el} tabindex="0" role="group" aria-label="Acid steps" data-testid="acid" onkeydown={key}>
  <div class="bar">
    <span class="grp" title="Base octave: the keys below are this octave">
      <button data-testid="acid-base-down" disabled={!canBase(base - 12)} aria-label="Base octave down" onclick={() => (base -= 12)}>−</button>
      <b class="base" data-testid="acid-base">{noteName(base)}</b>
      <button data-testid="acid-base-up" disabled={!canBase(base + 12)} aria-label="Base octave up" onclick={() => (base += 12)}>+</button>
    </span>
    <label title="Pattern length in bars (notes past the end are kept, silent)">Length
      <select data-testid="acid-length" value={pat.bars} onchange={(e) => setLength(Number(e.currentTarget.value))}>
        {#each lengths as b (b)}<option value={b}>{b} {b === 1 ? 'bar' : 'bars'}</option>{/each}
      </select>
    </label>
    <label>Root
      <select data-testid="acid-root" bind:value={root}>
        {#each NOTE_NAMES as n, k (k)}<option value={k}>{n}</option>{/each}
      </select>
    </label>
    <label>Scale
      <select data-testid="acid-scale" bind:value={scale}>
        {#each Object.keys(SCALES) as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <span class="grp">
      <button data-testid="acid-randomize" disabled={!view.ok} title="New random steps in {NOTE_NAMES[root]} {scale}"
        onclick={() => write(randomize(steps.length, root, scale, Math.random), 'Randomize steps')}>Randomize</button>
      <button data-testid="acid-mutate" disabled={!view.ok} title="Re-roll a few steps"
        onclick={() => write(mutate(steps, root, scale, Math.random), 'Mutate steps')}>Mutate</button>
    </span>
    <span class="grp">
      <button data-testid="acid-shift-left" disabled={!view.ok || empty} title="Shift one step earlier" aria-label="Shift left"
        onclick={() => write(shift(steps, -1), 'Shift steps')}>←</button>
      <button data-testid="acid-shift-right" disabled={!view.ok || empty} title="Shift one step later" aria-label="Shift right"
        onclick={() => write(shift(steps, 1), 'Shift steps')}>→</button>
    </span>
    <span class="grp" title="Transpose every note of the pattern">
      {#each TRANSPOSE as [semis, text] (semis)}
        <button data-testid="acid-transpose-{semis}" disabled={!canTranspose(semis)} aria-label="Transpose {text}"
          onclick={() => transposeAcid(p, engine, track.id, semis)}>{text}</button>
      {/each}
    </span>
    <button data-testid="acid-clear" disabled={!view.ok || empty} onclick={() => write(steps.map(() => REST), 'Clear steps')}>Clear</button>
  </div>

  {#if slideHint}<div class="hint" data-testid="acid-slide-hint">{SLIDE_HINT}</div>{/if}

  {#if !view.ok}
    <div class="notice" data-testid="acid-unshowable" role="status">
      <span>This pattern has notes the Acid tab can't show ({REASON[view.reason]})</span>
      <button data-testid="acid-convert" onclick={convert}>Convert to steps</button>
    </div>
  {:else}
    <div class="rows" style:--c={track.color}>
      {#each rows as r (r)}
        <div class="row">
          {#each { length: ROW } as _, c (c)}
            {@const i = r * ROW + c}
            {@const s = steps[i]}
            <button
              class="cell {s.kind}"
              class:sel={sel === i}
              class:beat={c % 4 === 0}
              class:group={c % 4 === 3 && c !== ROW - 1}
              class:playhead={i === playStep}
              data-testid="acid-step-{i}"
              aria-pressed={sel === i}
              aria-label={stepLabel(i, s)}
              onclick={() => pick(i)}
            >
              <span class="nm">{s.kind === 'note' ? NOTE_NAMES[s.key] : s.kind === 'tie' ? '~' : '—'}</span>
              {#if s.kind === 'note' && s.oct !== 0}<span class="oct">{s.oct > 0 ? '▲' : '▼'}</span>{/if}
              <span class="badges">
                {#if s.accent}<span class="acc">A</span>{/if}
                {#if s.slide}<span class="sld">⤳</span>{/if}
              </span>
            </button>
          {/each}
        </div>
      {/each}
    </div>

    <div class="edit" class:off={sel === null}>
      <div class="keys" role="group" aria-label="Step pitch">
        {#each NOTE_NAMES as n, k (k)}
          <button
            class="key" class:black={BLACK.has(k)} class:on={cur?.kind === 'note' && cur.key === k}
            data-testid="acid-key-{k}" disabled={sel === null}
            aria-pressed={cur?.kind === 'note' && cur.key === k}
            title={noteName(base + k)} onclick={() => setKey(k)}
            onpointerdown={(e) => { if (e.button === 0) auditionKey(k); }}
            onpointerup={auditionStop} onpointercancel={auditionStop}
          >{n}</button>
        {/each}
      </div>
      <div class="toggles">
        <button data-testid="acid-oct-down" disabled={cur?.kind !== 'note' || cur.oct === -1} title="Octave down" aria-label="Octave down" onclick={() => setOct(-1)}>▼</button>
        <button data-testid="acid-oct-up" disabled={cur?.kind !== 'note' || cur.oct === 1} title="Octave up" aria-label="Octave up" onclick={() => setOct(1)}>▲</button>
        <button data-testid="acid-accent" class:on={cur?.accent} aria-pressed={!!cur?.accent} disabled={!canAccent}
          title={canAccent ? 'Accent (Shift+A)' : 'Accent needs a note'} onclick={toggleAccent}>Accent</button>
        <button data-testid="acid-slide" class:on={cur?.slide} aria-pressed={!!cur?.slide} disabled={!canSlide}
          title={canSlide ? 'Slide into the next note (Shift+S)' : cur?.kind === 'rest' ? NO_NOTE : NO_NEXT} onclick={toggleSlide}>Slide</button>
        <button data-testid="acid-rest" class:on={cur?.kind === 'rest'} aria-pressed={cur?.kind === 'rest'} disabled={sel === null}
          title="Rest (Shift+R, Delete)" onclick={toggleRest}>Rest</button>
        <button data-testid="acid-tie" class:on={cur?.kind === 'tie'} aria-pressed={cur?.kind === 'tie'} disabled={!canTie}
          title={canTie ? 'Tie: hold the note before (Shift+T)' : 'Tie needs a note before it'} onclick={toggleTie}>Tie</button>
        <span class="tip">{sel === null ? 'Select a step, then play notes or click a key' : `Step ${sel + 1} · play a note to enter it`}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Tokens only (spec §2; ui-theme.md). Off cells are recessed --well (beats
     a shade lighter), notes are the track colour (--c) with the gloss and
     dark text, ties a 30 % tint; the selection is an accent ring outside the
     cell, the playhead a white ring inside it with a dark inner edge so it
     reads on pale track colours too. */
  .acid { display: flex; flex-direction: column; gap: 8px; outline: none; color: var(--text-2); }
  .acid:focus-visible { box-shadow: inset 0 0 0 1px var(--line); border-radius: var(--r-sm); }
  button {
    font: 500 var(--fs-ctl)/16px var(--font-ui); padding: 3px 9px; border: 0; border-radius: var(--r-sm);
    background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); cursor: pointer;
  }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.on { background-color: var(--accent); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .bar label { display: flex; align-items: center; gap: 6px; }
  .grp { display: flex; align-items: center; gap: 2px; }
  .base { min-width: 30px; text-align: center; color: var(--text); font: 600 var(--fs-ctl) var(--font-mono); }
  .hint { color: var(--text-2); font-size: var(--fs-ctl); }
  .notice {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: var(--r-md);
    background: var(--well); box-shadow: var(--well-shadow); color: var(--accent);
  }
  .notice button { background-color: var(--accent); color: var(--on-color); font-weight: 700; }
  .rows { display: flex; flex-direction: column; gap: 3px; user-select: none; }
  .row { display: flex; gap: 3px; }
  .cell {
    flex: 1 1 0; min-width: 22px; max-width: 52px; height: 34px; padding: 1px 2px; position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0;
    background: var(--well); box-shadow: var(--well-shadow); color: var(--text); line-height: 1.1;
  }
  .cell.beat { background: color-mix(in srgb, var(--well), var(--work)); }
  .cell.group { margin-right: 9px; }
  .cell.note { background: var(--c) var(--gloss); box-shadow: var(--raised-shadow); color: var(--on-color); }
  .cell.tie { background: color-mix(in srgb, var(--c) 30%, var(--well)); color: var(--text); }
  .cell.rest { color: var(--text-dim); }
  .cell.sel { box-shadow: 0 0 0 2px var(--accent), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
  .cell.playhead { box-shadow: inset 0 0 0 2px var(--text), inset 0 0 0 3px color-mix(in srgb, var(--on-color) 70%, transparent); }
  /* Selected under the playhead: the selection ring stays, the playhead inside it. */
  .cell.sel.playhead {
    box-shadow: 0 0 0 2px var(--accent), inset 0 0 0 2px var(--text), inset 0 0 0 3px color-mix(in srgb, var(--on-color) 70%, transparent);
  }
  .cell.playhead.rest { background: color-mix(in srgb, var(--well), var(--raised)); }
  .nm { font: 600 var(--fs-ctl) var(--font-ui); }
  .oct { position: absolute; top: 1px; right: 3px; font-size: var(--fs-tag); opacity: 0.8; }
  .badges { display: flex; gap: 3px; height: 11px; font-size: var(--fs-xs); }
  .acc { font-weight: 700; }
  /* On a rest or tie (no colour behind it) the badges take the accent / play colours. */
  .cell:not(.note) .acc { color: var(--accent); }
  .cell:not(.note) .sld { color: var(--play); }
  .edit { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  /* No step selected: the hint reads as a hint (italic), at full --text-2 contrast. */
  .edit.off .tip { font-style: italic; }
  .keys { display: flex; gap: 2px; }
  .key { width: 30px; padding: 4px 0; background: var(--text) var(--gloss); color: var(--on-color); }
  .key.black { background: var(--lcd) var(--gloss); color: var(--text-2); }
  .key.on { background-color: var(--accent); color: var(--on-color); }
  .toggles { display: flex; align-items: center; gap: 3px; }
  .tip { margin-left: 8px; font-size: var(--fs-ctl); color: var(--text-2); }
</style>
