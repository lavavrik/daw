<script lang="ts">
  // The top bar (plan 20 Task 5; spec §4 "Top bar"; the approved canvas board
  // "Song view"; plan 21 Task 3 the menu bar). One 64 px row, left to right:
  //
  //   [menu row / project name + hint line · ↶ ↷] | ▶ ■ Loop · Tempo LCD ·
  //   BIG TIMER · metronome · Master slider · mini spectrum · (spacer) ·
  //   [one warning badge, only when something needs attention]
  //
  // LEFT BLOCK (plan 21): the MENU ROW on top — File · Edit · Add · Patterns
  // · View · Options · Help (MenuBar.svelte, which holds the menus, their
  // keyboard model and plan 20's ⋯ items under their old test ids) — and
  // under it the name + hint stack with ↶ ↷ beside it. ↶ ↷ moved in from
  // the bar's row: the menu row (252 px) is wider than the old name stack
  // and the ⋯ together, and the bar must still fit one row at 1280 px.
  // Short windows (< 740 px, the 40 px bar): two lines, the 16 px menu row,
  // then name · hint · ↶ ↷ (18 px) on one line. (Plan 21's ruling put the
  // name after the menus on line 1; at 1280 px that line would be ~380 px
  // and the bar could not stay one row, so the name went to line 2.)
  //
  // PROJECT NAME (`project-menu` button, `project-name` inside) with a "●"
  // when unsaved (the word "unsaved" is there for screen readers and tests,
  // visually hidden). A click opens the File menu.
  //
  // HINT LINE (`hint-line`, under the name; spec: "the last tooltip or status
  // message"). In order: the app's flashed hint (banners.hint: flashHint(),
  // the MIDI-learn hint), else the title (or aria-label) of the control the
  // pointer last went over anywhere in the app (one `mouseover` listener on
  // the document; bigTimer.ts hintText walks up to the nearest titled
  // element), else a static tip. It is aria-hidden: the titles and the
  // bottom panel's role="status" flash already reach screen readers.
  //
  // ⌘O (App) calls `request`, which hands it to MenuBar.request (the File
  // menu's inline "Discard and open…" question). Options ▸ MIDI… opens the
  // MIDI popover under the Options button (Esc returns the focus there);
  // Options ▸ Audio settings… and View ▸ Performance open the Audio settings
  // dialog (Settings.svelte, modal; the focus returns to the menu button).
  //
  // UNDO / REDO (↶ ↷): the history's newest entries, named in the tooltips
  // ("Undo Move notes"); ⌘Z / ⇧⌘Z (Ctrl+Y) do the same (input/shortcuts.ts).
  //
  // SONG TRANSPORT (44 px; spec §4): Play (`play`, "Play song") is a toggle
  // button (aria-pressed while the SONG plays, and it glows): like Space
  // outside the bottom panel, it sets Song mode and plays, stopping the
  // pattern transport first, and a second press stops. It goes through the
  // App (onToggleSong) so the recorder's stop tick is handled in one place.
  // "Stop all" (`song-stop`) stops whichever transport runs (onStop). Loop
  // (`loop-toggle`) belongs to the song transport, whichever ran last. The
  // pattern transport, with Rec and Count-in, is in the bottom panel's
  // header (PatternTransport.svelte).
  //
  // TEMPO: NumberField's LCD variant (`aria-label` "BPM"; scrub, wheel,
  // arrows, ▲▼; one undo entry per commit). Enter commits and then releases
  // the focus (so Space and the piano work again): the field commits on
  // Enter itself, the wrapper's bubbling keydown then blurs it, and the blur
  // finds nothing left to commit (SET_TEMPO is sent once).
  //
  // BIG TIMER: BigTimer.svelte (the song position, bar:beat:tick + seconds).
  //
  // MASTER (`master-volume`): the master channel's fader, the mixer's own
  // value and action (setMix 'fader' on 'master'), drawn as the slider
  // variant of Knob.svelte. The catalog's fader param has curve 'fader', so
  // the track IS the fader law (0 dB at 3/4). Knob gives it everything the
  // mixer's controls have: one undo entry per drag, a click on the track
  // jumps, double-click 0 dB, typed entry, arrows, Esc / Cmd+Z cancel, the
  // automation follow (registered on the auto bus as the Master strip's
  // Fader is: a master fader lane moves it while it plays, and a drag
  // overrides it) and, on right-click, the precise-value popover (plan 24,
  // ui/ValuePopover.svelte: "0" sets 0.0 dB, "-inf" silence) with the
  // Automate / MIDI-learn items under it.
  //
  // MINI SPECTRUM (`topbar-spectrum`): a 20-band view of the master on the
  // analyser bus (ui/vis/Spectrum.svelte, no labels) on an --lcd well; a
  // click opens the Mixer tab, where the full analyser is.
  //
  // RIGHT (plan 22 Task 1, the owner: "move it all into proper menus"):
  // EMPTY in the normal state. Keys → track and the octave are Options ▸
  // Keyboard; the MIDI status is Options ▸ MIDI…'s label ("MIDI: Arturia
  // KeyStep" / "no device" / "blocked"); CPU, dropouts and latency are View ▸
  // Performance, a live item that opens Audio settings. Their test ids moved
  // with them (keys-target, octave, midi-status, cpu, latency,
  // settings-button). Telemetry still refreshes here at 4 Hz: it feeds that
  // item and the badge.
  // ONE BADGE (the `audio-status` slot, data-state = audio/audioStatus.ts
  // kind; empty and 0 px wide when all is well) shows the first of:
  //   - audio paused / failed: AudioStatusPill ("Audio paused — click
  //     anywhere to start" resumes, "Audio failed — retry" retries);
  //   - dropouts in the last 10 s, MIDI blocked, output latency over 40 ms
  //     (Bluetooth): `topbar-warning` (data-kind), decided by topStatus.ts.
  //     A click opens Audio settings (dropouts, latency) or the MIDI popover
  //     under the badge (blocked: it says how to unblock). "MIDI blocked"
  //     has a × (`topbar-warning-dismiss`) that hides it until MIDI is
  //     allowed and blocked again (topStatus.ts; localStorage).
  // If the engine dies after start, a red "Audio engine stopped — reload"
  // alert appears before it.
  //
  // LAYOUT: one row that never wraps at ≥ 1280 px (e2e layout.spec.ts /
  // topbar.spec.ts measure it, playing, unsaved and with a dropout badge or
  // the "Audio paused" pill). Fixed widths where text changes (the name and
  // hint, Play/Stop, the timer's digits, the master readout), so playback
  // never re-flows the bar. The room the pills left (plan 22) went to
  // breathing space: 8 px between the groups (4 px below 1400 px, for the
  // paused pill at 1280 px), and the mini spectrum grows to
  // 360 px; it is the one flexible part, so a badge or the paused pill takes
  // its room at 1280 px (it never goes under 66 px).
  // overflow-x: clip is the last guard: it never becomes a scroll container,
  // so the popovers can drop below. (It is also half of why a base-select
  // inside a <details> in the bar could not be picked from: Settings.svelte.)
  // The Settings dialog and the MIDI popover render AFTER the <header>, so
  // nothing in the bar clips or stacks over them.
  import { onMount, tick } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import { mixParam } from '../audio/mixerCatalog';
  import type { LatencyHint } from '../audio/restart';
  import Settings from './Settings.svelte';
  import AudioStatusPill from './AudioStatusPill.svelte';
  import type { AudioStatus } from '../audio/audioStatus';
  import Spectrum from './vis/Spectrum.svelte';
  import NumberField from './NumberField.svelte';
  import BigTimer from './BigTimer.svelte';
  import Knob from './rack/Knob.svelte';
  import { THEME } from './theme';
  import { hintText } from './bigTimer';
  import { setLoop, transportPlaying } from '../state/song-actions';
  import Icon from './Icon.svelte';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import ArrowCounterClockwise from 'phosphor-svelte/lib/ArrowCounterClockwise';
  import Metronome from 'phosphor-svelte/lib/Metronome';
  import Play from 'phosphor-svelte/lib/Play';
  import Repeat from 'phosphor-svelte/lib/Repeat';
  import Stop from 'phosphor-svelte/lib/Stop';
  import Warning from 'phosphor-svelte/lib/Warning';
  import { previewTempo, setMetronome, setTempo } from '../state/actions';
  import { setMix } from '../state/mixer-actions';
  import type { Project } from '../state/project.svelte';
  import type { MidiStatus } from '../input/midi';
  import MidiPopover from './MidiPopover.svelte';
  import MenuBar from './MenuBar.svelte';
  import type { PanelTab } from '../input/shortcuts';
  import { IS_MAC } from '../input/shortcutList';
  import { DEFAULT_OCTAVE } from '../input/qwertyPiano';
  import { createDropWindow, dismissMidiBlocked, midiBlockedDismissed, topWarning } from './topStatus';
  import X from 'phosphor-svelte/lib/X';
  import type { Recorder, RecStatus } from '../state/recorder';
  import type { ProjectSession } from '../project/session';
  import { banners } from '../state/banners.svelte';

  let {
    p,
    engine,
    clock = null,
    octave = DEFAULT_OCTAVE,
    onOctave = () => {},
    midi = { state: 'no-devices', devices: [] },
    midiCc = null,
    recorder,
    rec,
    onToggleSong,
    onStop,
    session,
    restoreOffer = null,
    undoLabels = { undo: null, redo: null },
    onUndo,
    onRedo,
    latencyHint = 'interactive',
    restarting = false,
    onApplyAudio = async () => null,
    onTab,
    audio = { kind: 'running' },
    onAudioResume = async () => {},
  }: {
    p: Project;
    engine: AudioEngine;
    /** The heard-time clock (the big timer); null before the engine starts. */
    clock?: AudioClock | null;
    octave?: number;
    /** Octave buttons / wheel: ask the App to change the octave (0..8). */
    onOctave?: (o: number) => void;
    midi?: MidiStatus;
    /** The last CC received, for the MIDI popover. */
    midiCc?: { cc: number; v: number } | null;
    recorder: Recorder;
    /** Recorder status, refreshed every frame by the App. */
    rec: RecStatus;
    /** Song Play / Stop (App: playSong / stop with the recorder hooks). */
    onToggleSong: () => void;
    /** Stop whichever transport runs (App: stopAny). */
    onStop: () => void;
    session: ProjectSession;
    /** The "Restore last session" offer, while it is open (New / Open would discard it). */
    restoreOffer?: { name: string } | null;
    /** What ↶ / ↷ would undo / redo (history labels; null: nothing). */
    undoLabels?: { undo: string | null; redo: string | null };
    onUndo: () => void;
    onRedo: () => void;
    /** The running engine's latency hint (Settings). */
    latencyHint?: LatencyHint;
    /** An audio restart is running. */
    restarting?: boolean;
    /** Settings ▸ Apply: restart audio with this hint (App); resolves with why it did not run, or null. */
    onApplyAudio?: (hint: LatencyHint) => Promise<string | null>;
    /** View ▸ an editor tab (App: BottomPanel.pickTab). */
    onTab?: (t: PanelTab) => void;
    /** Is audio running yet (App: the engine's context state)? */
    audio?: AudioStatus;
    /** The audio pill's click: resume, or retry after a failure (App). */
    onAudioResume?: () => Promise<void>;
  } = $props();

  /** The Audio settings dialog mounts while open (its readout polls only then). */
  let settingsOpen = $state(false);
  /** Where its close puts the focus (the menu button or the badge that opened it). */
  let settingsReturn = $state<HTMLElement | null>(null);

  // ---- menu bar (MenuBar.svelte) -------------------------------------------
  const mod = IS_MAC ? '⌘' : 'Ctrl+';
  let nameBtn = $state<HTMLElement | null>(null);
  let menuBar = $state<{
    toggle(m: 'File', from: HTMLElement): void;
    request(cmd: 'new' | 'open'): void;
    menuButton(m: 'Options'): HTMLButtonElement | null;
  } | null>(null);
  /** The open menu (MenuBar binds it): the name button shows File's state. */
  let menuOpen = $state<string | null>(null);
  /** ⌘O / Ctrl+O (App's shortcut): MenuBar.request (the File menu's discard question). */
  export function request(cmd: 'new' | 'open') {
    menuBar?.request(cmd);
  }
  // The MIDI popover: under what opened it (`midiAt`: the Options button or
  // the badge). Esc returns the focus to `midiBack`; presses on `midiToggle`
  // (the badge) are its own toggle, not "outside".
  let midiOpen = $state(false);
  let midiAt = $state<HTMLElement | null>(null);
  let midiBack = $state<HTMLElement | null>(null);
  let midiToggle = $state<HTMLElement | null>(null);
  /** Options ▸ MIDI…: the popover under the Options button. */
  function openMidi(back: HTMLElement) {
    midiAt = midiBack = back;
    midiToggle = null;
    midiOpen = true;
  }
  /** Options ▸ Audio settings…, View ▸ Performance, the badge: the modal. */
  async function openSettings(back: HTMLElement | null) {
    // Paused: resume first (the click is the gesture), so Apply and the
    // readout see a running context. A refusal turns the badge into
    // "Audio failed — retry"; the dialog still opens (it says what runs).
    if (audio.kind !== 'running') {
      await onAudioResume();
      await tick();
    }
    settingsReturn = back;
    settingsOpen = true;
  }

  // ---- hint line -----------------------------------------------------------
  const TIP = 'Tip: point at a control to see what it does';
  /** The title of the control the pointer last went over (anywhere in the app). */
  let hovered = $state<string | null>(null);
  onMount(() => {
    const over = (e: MouseEvent) => {
      const t = hintText(e.target instanceof Element ? e.target : null);
      if (t) hovered = t;
    };
    document.addEventListener('mouseover', over);
    return () => document.removeEventListener('mouseover', over);
  });
  const hint = $derived(banners.hint ?? hovered ?? TIP);

  // ---- transport / tempo / master ------------------------------------------
  const songPlaying = $derived(transportPlaying(p, 'song'));
  /** Enter committed (NumberField's own keydown ran first): release the focus. */
  function blurAfterEnter(e: KeyboardEvent) {
    if (e.key === 'Enter' && e.target instanceof HTMLElement) e.target.blur();
  }
  /** The master fader as the top bar's slider: the catalog param with a shorter label. */
  const MASTER_DEF = { ...mixParam('fader'), label: 'Master' };
  const MASTER_AUTO = { owner: 'master', target: { kind: 'mix', param: 'fader' } } as const;
  const masterDb = $derived(p.mixer.master.params[MASTER_DEF.id] ?? MASTER_DEF.default);

  // ---- telemetry, the badge ----------------------------------------------
  let cpu = $state(0);
  let dropouts = $state(0);
  /** Dropouts in the last 10 s (the badge). */
  let recentDrops = $state(0);
  const drops = createDropWindow();
  let latency = $state('');
  let latencyMs = $state(0);
  let engineError = $state<string | null>(null); // set from engine.failure (effect below)
  /** The mini spectrum's measured width (it grows when the bar has room). */
  let miniW = $state(66);
  /** View ▸ Performance's live readout. */
  const perf = $derived({ cpu, dropouts, latencyMs, latencyText: latency });
  // The badge's × on "MIDI blocked" (topStatus.ts): re-read on every MIDI
  // status (App clears it first on a granted one) and after a dismissal.
  let dismissTick = $state(0);
  const midiDismissed = $derived.by(() => {
    void midi;
    void dismissTick;
    return midiBlockedDismissed();
  });
  const warning = $derived(audio.kind === 'running' ? topWarning({ recentDrops, midi: midi.state, latencyMs, midiDismissed }) : null);
  function dismissMidi() {
    dismissMidiBlocked();
    dismissTick++;
    if (midiOpen && midiToggle === badge) midiOpen = false;
    menuBar?.menuButton('Options')?.focus(); // the badge goes: the focus to where "MIDI: blocked" still shows
  }
  let badge = $state<HTMLElement | null>(null);
  function badgeClick() {
    if (!warning || !badge) return;
    if (warning.kind === 'midi') {
      if (midiOpen) midiOpen = false;
      else {
        midiAt = midiBack = midiToggle = badge;
        midiOpen = true;
      }
    } else void openSettings(badge);
  }

  function refresh() {
    cpu = Math.round(engine.telemetry()[TELEMETRY.cpu] * 100);
    dropouts = engine.dropouts();
    recentDrops = drops.push(performance.now(), dropouts);
    latencyMs = engine.latencyMs();
    latency = `Output latency ${latencyMs.toFixed(1)} ms at ${engine.sampleRate / 1000} kHz`;
  }

  onMount(() => {
    refresh();
    const id = setInterval(refresh, 250); // reads the `engine` prop: follows a restart
    return () => clearInterval(id);
  });
  // Per engine: an audio restart hands over a new one (the old one closes
  // without firing onError).
  $effect(() => {
    const e = engine;
    e.onError = (msg) => (engineError = msg);
    engineError = e.failure; // in case it failed before mount
    return () => {
      e.onError = undefined;
    };
  });
</script>

<header class="bar">
  <div class="proj">
    <div class="menus">
      <MenuBar
        bind:this={menuBar} bind:open={menuOpen} alsoInside={nameBtn}
        {p} {engine} {session} {restoreOffer} {recorder} {rec} {undoLabels} {onUndo} {onRedo} {octave} {onOctave} {onTab} {midi} {perf}
        onOpenMidi={openMidi} onOpenSettings={(back) => void openSettings(back)}
      />
    </div>
    <div class="id">
      <button
        class="name" data-testid="project-menu" title="Project: New, Open, Save, Export (the File menu)" aria-expanded={menuOpen === 'File'} aria-controls="menu-file-panel"
        bind:this={nameBtn} onclick={() => nameBtn && menuBar?.toggle('File', nameBtn)}
      ><span data-testid="project-name"><span class="pname">{p.name}</span>{#if p.dirty}<span class="unsaved" title="Unsaved changes">●<span class="sr-only">{' '}unsaved</span></span>{/if}</span></button>
      <span class="hint" data-testid="hint-line" aria-hidden="true">{hint}</span>
    </div>
    <span class="grp undo" role="group" aria-label="Undo and redo">
      <button
        class="ib" data-testid="undo" aria-label="Undo" disabled={!undoLabels.undo || p.loading} onclick={onUndo}
        title={undoLabels.undo ? `Undo ${undoLabels.undo} (${mod}Z)` : 'Nothing to undo'}
      ><Icon icon={ArrowCounterClockwise} /></button>
      <button
        class="ib" data-testid="redo" aria-label="Redo" disabled={!undoLabels.redo || p.loading} onclick={onRedo}
        title={undoLabels.redo ? `Redo ${undoLabels.redo} (⇧${mod}Z)` : 'Nothing to redo'}
      ><Icon icon={ArrowClockwise} /></button>
    </span>
  </div>

  <span class="sep" aria-hidden="true"></span>

  <span class="grp" role="group" aria-label="Song transport">
    <button class="tp play" class:on={songPlaying} aria-pressed={songPlaying} onclick={onToggleSong} title="Play / Stop the song (Space)" data-testid="play">
      <Icon icon={Play} size={20} weight="fill" /><span class="sr-only">Play song</span>
    </button>
    <button class="tp" data-testid="song-stop" aria-label="Stop all" title="Stop all (the song or the pattern)" onclick={onStop}>
      <Icon icon={Stop} weight="fill" />
    </button>
    <button
      class="tp" class:on={p.loop.on} aria-pressed={p.loop.on} aria-label="Loop" data-testid="loop-toggle"
      onclick={() => setLoop(p, engine, { on: !p.loop.on })} title="Loop the loop range while playing the song"
    ><Icon icon={Repeat} size={20} /></button>
  </span>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tempo" onkeydown={blurAfterEnter}>
    <NumberField
      variant="lcd" label="Tempo" ariaLabel="BPM" testid="tempo" min={20} max={300} step={1} decimals={1}
      title="Tempo (BPM): drag up/down, wheel or arrows (Shift = 0.1), or type" value={p.tempo}
      onchange={(v) => setTempo(p, engine, v)} onpreview={(v) => previewTempo(engine, v)}
    />
  </div>

  <BigTimer {p} {clock} />

  <button class="ib" class:on={p.metronome} aria-pressed={p.metronome} onclick={() => setMetronome(p, engine, !p.metronome)} title="Metronome" aria-label="Metronome">
    <Icon icon={Metronome} />
  </button>

  <div class="master">
    <Knob variant="slider" def={MASTER_DEF} value={masterDb} color="var(--accent)" testid="master-volume" auto={MASTER_AUTO} onchange={(v) => setMix(p, engine, 'master', 'fader', v)} />
  </div>

  <!-- 3× the old 66 px (owner), shrinking toward 66 px when the bar is
       tight (1280 px): it takes the spacer's room first. -->
  <button class="mini" data-testid="topbar-spectrum" title="Master spectrum — click for the mixer" aria-label="Master spectrum — click for the mixer" onclick={() => (p.mixerOpen = true)} bind:clientWidth={miniW}>
    <Spectrum need="mini" width={Math.max(58, miniW - 8)} height={30} color={THEME.play} />
  </button>

  <span class="spacer"></span>
  {#if engineError}
    <span class="fatal" role="alert" data-testid="engine-error" title={engineError}>
      Audio engine stopped — <button onclick={() => location.reload()}>reload</button>
    </span>
  {/if}

  <!-- The one badge (see RIGHT): 0 px wide while all is well. -->
  <span class="status" data-testid="audio-status" data-state={audio.kind}>
    {#if audio.kind !== 'running'}
      <AudioStatusPill status={audio} onresume={() => void onAudioResume()} />
    {:else if warning}
      <button
        class="badge" class:latency={warning.kind === 'latency'} class:dismissable={warning.kind === 'midi'}
        data-testid="topbar-warning" data-kind={warning.kind}
        title={warning.title} bind:this={badge} onclick={badgeClick}
        aria-haspopup="dialog" aria-expanded={warning.kind === 'midi' ? midiOpen : undefined}
      ><Icon icon={Warning} size={12} weight="bold" />{warning.label}</button>
      {#if warning.kind === 'midi'}
        <button
          class="badge-x" data-testid="topbar-warning-dismiss" aria-label="Hide the MIDI blocked warning"
          title="Don't show this again (until MIDI is allowed and then blocked again). Options ▸ MIDI still says it."
          onclick={dismissMidi}
        ><Icon icon={X} size={10} weight="bold" /></button>
      {/if}
    {/if}
  </span>
</header>
{#if midiOpen}
  <MidiPopover {p} status={midi} cc={midiCc} anchor={midiAt} toggle={midiToggle} returnFocus={midiBack} onclose={() => (midiOpen = false)} />
{/if}
{#if settingsOpen}
  <Settings
    {engine} hint={latencyHint} busy={restarting || p.loading}
    blocked={banners.exporting ? 'Wait for the export to finish' : null}
    onApply={onApplyAudio} returnFocus={settingsReturn} fallbackFocus={menuBar?.menuButton('Options') ?? null}
    onclose={() => (settingsOpen = false)}
  />
{/if}

<style>
  /* Tokens only (spec §2; the canvas board "Song view"). Widths: see LAYOUT
     in the header comment; layout.spec.ts measures the bar at 1440 / 1400 /
     1280 / 1024 px. Below 1280 px the bar may wrap onto a second row. */
  .bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 64px; box-sizing: border-box; padding: 0 12px;
    background: var(--top); border-bottom: 1px solid var(--line); white-space: nowrap; overflow-x: clip;
    position: relative; z-index: 5; font: var(--fs-ctl) var(--font-ui); color: var(--text);
  }
  /* 8 px between the groups where there is room; 4 px below 1400 px, where
     the "Audio paused" pill (228 px) needs it to keep one row at 1280 px. */
  @media (max-width: 1399px) { .bar { gap: 4px; } }
  .bar > :global(*) { flex: none; }
  .bar > .spacer { flex: 1; }
  .sep { width: 1px; height: 36px; background: var(--line); }
  .grp { display: inline-flex; align-items: center; gap: 4px; }

  /* The left block (plan 21): the menu row on top; under it the name + hint
     stack and ↶ ↷ (they moved in from the bar's row so the wider block still
     fits one row at 1280 px). Short windows: see the media query below. */
  .proj {
    position: relative; display: grid; grid-template-columns: 128px auto; grid-template-areas: "menu menu" "id undo";
    align-items: center; column-gap: 8px; row-gap: 1px;
  }
  .menus { grid-area: menu; }
  .id { grid-area: id; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .undo { grid-area: undo; justify-self: start; }
  .name { display: block; max-width: 100%; padding: 0; border: 0; background: none; color: var(--text); font: 700 14px/18px var(--font-ui); text-align: left; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .name:hover .pname { text-decoration: underline; text-decoration-color: var(--text-2); }
  .name:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .unsaved { margin-left: 6px; color: var(--accent); font-size: 10px; vertical-align: 2px; }
  .hint { overflow: hidden; text-overflow: ellipsis; font-size: 11px; line-height: 14px; color: var(--text-2); }

  /* Icon buttons (32 px) and transport buttons (44 px): raised, with the gloss. */
  .ib, .tp {
    display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; cursor: pointer;
    background: var(--raised) var(--gloss); color: var(--text); box-shadow: var(--raised-shadow); font: inherit;
  }
  .ib { width: 32px; height: 32px; border-radius: var(--r-md); }
  .tp { width: 44px; height: 44px; border-radius: var(--r-lg); }
  .ib:hover:not(:disabled), .tp:hover:not(:disabled) { filter: brightness(1.08); }
  .ib:active:not(:disabled), .tp:active:not(:disabled) { translate: 0 1px; }
  /* Disabled is flat (no gloss, no shadow) and faint, never just a dim
     raised button: idle (enabled) controls must not look disabled. */
  .ib:disabled, .tp:disabled { opacity: 0.4; background: var(--raised); box-shadow: none; cursor: not-allowed; }
  .ib:focus-visible, .tp:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ib.on, .tp.on { background-color: var(--accent); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 10px color-mix(in srgb, var(--accent) 40%, transparent); }
  /* The song transport speaks the pattern transport's language
     (PatternTransport.svelte): idle Play is a raised button with a light
     green icon (3.3:1 on --raised), playing it is filled --play with an
     --on-color icon and a glow; Stop is a raised button with a --text icon
     (enabled while stopped too: a no-op then). */
  .tp.play { color: color-mix(in srgb, var(--play) 55%, var(--text)); }
  .tp.play.on { background-color: var(--play); color: var(--on-color); box-shadow: var(--raised-shadow), 0 0 16px color-mix(in srgb, var(--play) 80%, transparent); }

  /* NumberField's LCD is sized for 3 digits + label; 58 px holds "124.5" at 18 px. */
  .tempo { display: flex; }
  .tempo { --nf-lcd-w: 58px; }
  /* Knob's slider has a 112 px minimum (the rack's grid); the bar has less room. */
  .master { width: 104px; }
  .master { --slider-min-w: 0px; }

  .mini { display: flex; align-items: center; justify-content: center; flex: 3 1 66px; min-width: 66px; max-width: 360px; height: 40px; padding: 0; border: 0; border-radius: var(--r-md); background: var(--lcd); box-shadow: var(--well-shadow); line-height: 0; cursor: pointer; }
  .mini:hover { filter: brightness(1.15); }
  .mini:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Right: the one badge (see RIGHT in the header comment). Warnings fill
     the badge (vivid colour, --on-color text: 5.6:1 on --rec, 8.8:1 on
     --accent); --rec or --accent text on --raised would be under 3:1. */
  .status { display: inline-flex; --pill-h: 22px; }
  .badge {
    position: relative; display: inline-flex; align-items: center; gap: 4px; height: var(--pill-h); box-sizing: border-box; padding: 0 8px;
    border: 0; border-radius: var(--r-md); background: var(--rec) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--on-color); font: 700 11px var(--font-ui); font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
  }
  .badge.latency { background-color: var(--accent); }
  .badge:hover { filter: brightness(1.08); }
  .badge:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  /* A 24 px hit area around the short badge. */
  .badge::after { content: ''; position: absolute; inset: -4px -2px; }
  /* "MIDI blocked" carries a × (dismiss) joined to its right end. */
  .badge.dismissable { border-radius: var(--r-md) 0 0 var(--r-md); padding-right: 6px; }
  .badge.dismissable::after { inset: -4px 0 -4px -2px; }
  .badge-x {
    position: relative; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: var(--pill-h);
    padding: 0; border: 0; border-left: 1px solid color-mix(in srgb, var(--on-color) 25%, transparent);
    border-radius: 0 var(--r-md) var(--r-md) 0; background: var(--rec) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--on-color); cursor: pointer;
  }
  .badge-x:hover { filter: brightness(1.08); }
  .badge-x:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .badge-x::after { content: ''; position: absolute; inset: -4px -2px -4px 0; }

  /* Short windows (< 740 px tall): a 40 px bar, so the piano roll keeps
     C2..C5 at 9 px rows at 1280×720 (pianoroll.spec.ts): 36 px transport
     buttons, tempo LCD and timer (BigTimer.svelte), a shorter badge. The
     approved 64 px look from 740 px up. */
  @media (max-height: 739px) {
    .bar { min-height: 40px; padding-block: 2px; }
    /* The left block in two lines: the menus, then the name, the hint and
       ↶ ↷ as 18 px buttons (a 24 px hit area) — 32 px ones would not fit
       under the menu row, and beside it the bar would not fit 1280 px. */
    .proj { grid-template-columns: minmax(0, 1fr) auto; column-gap: 6px; }
    /* contain: the hint's length never widens the block (the menu row sets its width). */
    .id { flex-direction: row; align-items: baseline; gap: 8px; contain: inline-size; }
    .name { flex: none; max-width: 112px; font-size: 13px; line-height: 17px; }
    .hint { flex: 1; min-width: 0; white-space: nowrap; }
    .undo .ib { position: relative; width: 24px; height: 18px; border-radius: var(--r-sm); }
    .undo .ib::after { content: ''; position: absolute; inset: -3px -1px; }
    .tp { width: 36px; height: 36px; border-radius: var(--r-md); }
    .sep { height: 28px; }
    .tempo { --nf-lcd-h: 36px; --nf-lcd-pad: 9px; }
    .mini { height: 32px; }
    .status { --pill-h: 17px; }
  }
  .fatal { padding: 4px 10px; border-radius: var(--r-sm); background: var(--rec); color: var(--on-color); font-weight: 700; }
  .fatal button { padding: 1px 8px; border: 0; border-radius: var(--r-sm); background: var(--text); color: var(--on-color); font: inherit; cursor: pointer; }
</style>
