<script lang="ts">
  // The top bar (plan 20 Task 5; spec §4 "Top bar"; the approved canvas board
  // "Song view"; plan 21 Task 3 the menu bar). One 64 px row, left to right:
  //
  //   [menu row / project name + hint line · ↶ ↷] | ▶ ■ Loop · Tempo LCD ·
  //   BIG TIMER · metronome · Master slider · mini spectrum · (spacer) ·
  //   [Keys → track, octave / MIDI, CPU, ⚙ latency] (two stacked pill rows)
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
  // MIDI popover under its pill (Esc then returns the focus to Options);
  // Options ▸ Audio settings… opens the ⚙ panel.
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
  // overrides it) and the Automate / MIDI-learn menu.
  //
  // MINI SPECTRUM (`topbar-spectrum`): a 20-band view of the master on the
  // analyser bus (ui/vis/Spectrum.svelte, no labels) on an --lcd well; a
  // click opens the Mixer tab, where the full analyser is.
  //
  // RIGHT: two rows of pills (as on the canvas): Keys → track and the octave
  // (wheel steps it); then MIDI (opens MidiPopover), CPU + dropouts, and the
  // ⚙ latency pill, which opens Settings (ui/Settings.svelte: latency hint,
  // sample rate / base / output / total latency, the Bluetooth hint, Apply =
  // engine restart via App). The latency turns orange above 40 ms. Until
  // the browser lets audio start (no start splash: spec 2026-11-15 §10) that
  // slot (`audio-status`, data-state = audio/audioStatus.ts kind) holds the
  // "Audio paused — click anywhere to start" pill instead, or "Audio failed —
  // retry" (AudioStatusPill.svelte). The CPU pill (0 % while nothing
  // renders) steps aside for the longer text, and below 1400 px the MIDI
  // pill too, so the bar keeps one row at 1280 px. Telemetry
  // refreshes at 4 Hz. If the engine dies after start, a red "Audio engine
  // stopped — reload" alert appears before the pills.
  //
  // LAYOUT: one row that never wraps at ≥ 1280 px (e2e layout.spec.ts /
  // topbar.spec.ts measure it, playing, unsaved and with a 3-digit dropout
  // tail). Fixed widths where text changes (the name and hint, Play/Stop,
  // the timer's digits, the master readout), so playback never re-flows the
  // bar; the long readouts (Keys target, MIDI device, project name, hint)
  // ellipsize with the full text in their tooltips. Below 1400 px CPU's
  // "· N drop" tail is hidden while there are none, and with dropouts the
  // red pill reads "1% · 123" (the words are in the tooltip). The widest
  // state at 1280 px (playing, unsaved, 123 dropouts) leaves ~25 px (~13 px
  // with the web fonts blocked).
  // overflow-x: clip is the last guard: it never becomes a scroll container,
  // so the popovers can drop below.
  import { onMount, tick } from 'svelte';
  import { TELEMETRY } from '../audio/protocol';
  import type { AudioEngine } from '../audio/engine';
  import type { AudioClock } from '../audio/audioClock';
  import { mixParam } from '../audio/mixerCatalog';
  import { BT_LATENCY_MS } from '../audio/restart';
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
  import { liveInputTrack, previewTempo, setMetronome, setTempo } from '../state/actions';
  import { setMix } from '../state/mixer-actions';
  import type { Project } from '../state/project.svelte';
  import type { MidiStatus } from '../input/midi';
  import MidiPopover from './MidiPopover.svelte';
  import MenuBar from './MenuBar.svelte';
  import type { PanelTab } from '../input/shortcuts';
  import { IS_MAC } from '../input/shortcutList';
  import { DEFAULT_OCTAVE, wheelOctaveSteps } from '../input/qwertyPiano';
  import type { Recorder, RecStatus } from '../state/recorder';
  import type { ProjectSession } from '../project/session';
  import { banners } from '../state/banners.svelte';

  // Wheel over the octave pill: accumulated (see wheelOctaveSteps). Svelte's
  // onwheel is passive, so this can't stop page scroll (the bar doesn't scroll).
  let wheelAcc = 0;
  function onOctaveWheel(e: WheelEvent) {
    const r = wheelOctaveSteps(wheelAcc, e.deltaY, e.deltaMode);
    wheelAcc = r.acc;
    if (r.steps) onOctave(Math.min(8, Math.max(0, octave + r.steps)));
  }

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
    onAudioResume = () => {},
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
    onAudioResume?: () => void;
  } = $props();

  /** The Settings panel mounts while open (its readout polls only then). */
  let settingsOpen = $state(false);

  // ---- menu bar (MenuBar.svelte) -------------------------------------------
  const mod = IS_MAC ? '⌘' : 'Ctrl+';
  let nameBtn = $state<HTMLElement | null>(null);
  let menuBar = $state<{ toggle(m: 'File', from: HTMLElement): void; request(cmd: 'new' | 'open'): void } | null>(null);
  /** The open menu (MenuBar binds it): the name button shows File's state. */
  let menuOpen = $state<string | null>(null);
  /** ⌘O / Ctrl+O (App's shortcut): MenuBar.request (the File menu's discard question). */
  export function request(cmd: 'new' | 'open') {
    menuBar?.request(cmd);
  }
  /** Options ▸ MIDI…: the popover under the pill; Esc returns the focus to `back` (the Options button). */
  let midiReturn = $state<HTMLElement | null>(null);
  function openMidi(back: HTMLElement) {
    midiReturn = back;
    midiOpen = true;
  }
  /** Options ▸ Audio settings…: open the ⚙ panel and focus its first control. */
  let settingsEl = $state<HTMLDetailsElement | null>(null);
  async function openSettings() {
    // Paused: the ⚙ pill is the audio pill until audio runs (that click already resumed it).
    if (!settingsEl) return onAudioResume();
    settingsEl.open = true;
    await tick();
    settingsEl.querySelector<HTMLElement>('.panel select, .panel button, .panel input')?.focus();
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

  // ---- pills ---------------------------------------------------------------
  // Reactive: follows track selection (project state is $state).
  const keysTrack = $derived(liveInputTrack(p));
  let midiOpen = $state(false);
  let midiBtn = $state<HTMLElement | null>(null);
  const midiLabel = $derived(
    midi.state === 'connected'
      ? midi.devices[0] + (midi.devices.length > 1 ? ` +${midi.devices.length - 1}` : '')
      : midi.state === 'denied'
        ? 'blocked'
        : midi.state === 'unsupported'
          ? 'unsupported'
          : 'no device',
  );
  const midiTip = $derived(
    midi.state === 'denied'
      ? 'MIDI access is blocked. Enable it in Chrome site settings (lock icon > Site settings > MIDI devices), then reload.'
      : midi.state === 'unsupported'
        ? 'This browser has no Web MIDI. Use Chrome.'
        : midi.state === 'connected' ? `MIDI: ${midi.devices.join(', ')}` : 'MIDI: no device connected',
  );
  const BT_TIP = 'High output latency — Bluetooth headphones? Use wired output for playing live.';

  let cpu = $state(0);
  let dropouts = $state(0);
  let latency = $state('');
  let latencyMs = $state(0);
  let engineError = $state<string | null>(null); // set from engine.failure (effect below)
  /** The mini spectrum's measured width (it grows to 3× when the bar has room). */
  let miniW = $state(66);

  function refresh() {
    cpu = Math.round(engine.telemetry()[TELEMETRY.cpu] * 100);
    dropouts = engine.dropouts();
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
        {p} {engine} {session} {restoreOffer} {recorder} {rec} {undoLabels} {onUndo} {onRedo} {octave} {onOctave} {onTab}
        onOpenMidi={openMidi} onOpenSettings={() => void openSettings()}
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

  <div class="io">
    <div class="row">
      <span class="pill keys" data-testid="keys-target" title="Computer keyboard and MIDI play this track">
        {#if keysTrack}
          <span class="sw" style:background={keysTrack.color}></span>Keys → {keysTrack.name}
        {:else}
          Keys → (no track)
        {/if}
      </span>
      <!-- mousedown is cancelled so a click never moves focus onto the button: Space keeps meaning play/stop (not "click the focused button") and the piano roll keeps its keyboard focus. -->
      <span class="pill octave" onwheel={onOctaveWheel}>
        <button class="oct" data-testid="octave-down" title="Octave down (Z)" aria-label="Octave down" disabled={octave <= 0}
          onmousedown={(e) => e.preventDefault()} onclick={() => onOctave(octave - 1)}>−</button>
        <span data-testid="octave" title="QWERTY octave (Z / X)">Oct {octave}</span>
        <button class="oct" data-testid="octave-up" title="Octave up (X)" aria-label="Octave up" disabled={octave >= 8}
          onmousedown={(e) => e.preventDefault()} onclick={() => onOctave(octave + 1)}>+</button>
      </span>
    </div>
    <div class="row small" class:audio-off={audio.kind !== 'running'}>
      <span class="midiwrap">
        <button class="pill midi" data-testid="midi-status" class:ok={midi.state === 'connected'} class:bad={midi.state === 'denied'} title={midiTip} bind:this={midiBtn}
          aria-haspopup="dialog" aria-expanded={midiOpen} onmousedown={(e) => e.preventDefault()} onclick={() => { midiReturn = null; midiOpen = !midiOpen; }}
        >{#if midi.state === 'connected'}<span class="led"></span>{/if}<span class="ell">MIDI: {midiLabel}</span></button>
        {#if midiOpen}
          <MidiPopover {p} status={midi} cc={midiCc} anchor={midiBtn} returnFocus={midiReturn} onclose={() => (midiOpen = false)} />
        {/if}
      </span>
      {#if audio.kind === 'running'}
        <span class="pill" class:bad={dropouts > 0} data-testid="cpu" title="Audio thread CPU load · {dropouts} dropouts (missed audio blocks) this session">
          <span class="cpuw">CPU{' '}</span>{cpu}%<span class="long">{' '}· {dropouts}<span class="dropw">{' '}drop</span></span>
        </span>
      {/if}
      <span class="audio" data-testid="audio-status" data-state={audio.kind}>
        {#if audio.kind === 'running'}
          <details class="pop settings" bind:this={settingsEl} ontoggle={(e) => (settingsOpen = (e.currentTarget as HTMLDetailsElement).open)}>
            <summary
              class="pill" data-testid="settings-button" aria-label="Audio settings" class:warn={latencyMs > BT_LATENCY_MS}
              title="{latencyMs > BT_LATENCY_MS ? `${latency}. ${BT_TIP}` : latency}. Click for audio settings."
            >⚙ <span data-testid="latency">{Math.round(latencyMs)} ms</span></summary>
            <div class="panel">
              {#if settingsOpen}
                <Settings
                  {engine} hint={latencyHint} busy={restarting || p.loading}
                  blocked={banners.exporting ? 'Wait for the export to finish' : null}
                  onApply={onApplyAudio}
                />
              {/if}
            </div>
          </details>
        {:else}
          <AudioStatusPill status={audio} onresume={onAudioResume} />
        {/if}
      </span>
    </div>
  </div>
</header>

<style>
  /* Tokens only (spec §2; the canvas board "Song view"). Widths: see LAYOUT
     in the header comment; layout.spec.ts measures the bar at 1440 / 1400 /
     1280 / 1024 px. Below 1280 px the bar may wrap onto a second row. */
  .bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 64px; box-sizing: border-box; padding: 0 12px;
    background: var(--top); border-bottom: 1px solid var(--line); white-space: nowrap; overflow-x: clip;
    position: relative; z-index: 5; font: var(--fs-ctl) var(--font-ui); color: var(--text);
  }
  .bar > :global(*) { flex: none; }
  .bar > .spacer { flex: 1; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; margin: 0; }
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

  /* Popover panel (the ⚙ Settings). */
  .panel {
    position: absolute; top: calc(100% + 8px); left: 0; z-index: 10; padding: 8px; white-space: normal;
    background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); color: var(--text);
  }
  .row { display: flex; gap: 6px; }

  /* NumberField's LCD is sized for 3 digits + label; 58 px holds "124.5" at 18 px. */
  .tempo { display: flex; }
  .tempo { --nf-lcd-w: 58px; }
  /* Knob's slider has a 112 px minimum (the rack's grid); the bar has less room. */
  .master { width: 104px; }
  .master { --slider-min-w: 0px; }

  .mini { display: flex; align-items: center; justify-content: center; flex: 3 1 66px; min-width: 66px; max-width: 198px; height: 40px; padding: 0; border: 0; border-radius: var(--r-md); background: var(--lcd); box-shadow: var(--well-shadow); line-height: 0; cursor: pointer; }
  .mini:hover { filter: brightness(1.15); }
  .mini:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Right: two rows of raised pills. */
  .io { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .io .row { gap: 4px; align-items: center; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px; height: 26px; box-sizing: border-box; padding: 0 8px; border: 0;
    border-radius: var(--r-md); background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow);
    color: var(--text); font: 500 var(--fs-ctl) var(--font-ui); font-variant-numeric: tabular-nums;
  }
  .small .pill { height: 22px; font-size: 11px; padding: 0 6px; }
  button.pill, summary.pill { cursor: pointer; }
  button.pill:hover, summary.pill:hover { filter: brightness(1.08); }
  .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pill.keys { display: block; line-height: 26px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
  .pill.midi { max-width: 120px; }
  .pill.midi .ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  /* Warnings fill the pill (vivid colour, --on-color text: 5.6:1 on --rec,
     8.8:1 on --accent); --rec or --accent text on --raised would be under 3:1. */
  .pill.bad { background-color: var(--rec); color: var(--on-color); font-weight: 700; }
  .pill.midi.ok { background-color: color-mix(in srgb, var(--play) 30%, var(--raised)); }
  .led { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--play); vertical-align: 1px; }
  .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
  .octave { padding: 0 2px; gap: 0; }
  .octave > span { padding: 0 2px; }
  button.oct { position: relative; width: 18px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; line-height: 1; cursor: pointer; }
  button.oct:disabled { opacity: 0.4; cursor: default; }
  /* Bigger hit area without changing the layout width. */
  button.oct::before { content: ''; position: absolute; inset: -6px -2px; }
  .midiwrap { position: relative; display: inline-flex; }
  .audio { display: inline-flex; --pill-h: 22px; }
  .pop { position: relative; }
  /* Block-level flex: no line box (and its strut) around the summary. */
  .pop summary.pill { display: flex; }
  .pop summary { list-style: none; }
  .pop summary::-webkit-details-marker { display: none; }
  .settings summary.warn { background-color: var(--accent); color: var(--on-color); font-weight: 700; }
  /* At the right edge: the panel opens leftwards. */
  .settings .panel { left: auto; right: 0; width: 270px; padding: 10px 12px; }
  @media (max-width: 1399px) {
    .pill:not(.bad) .long { display: none; }
    .pill.keys { max-width: 120px; }
    .pill.midi { max-width: 88px; }
    /* With dropouts the red pill drops its "CPU " and "drop" words: "1% · 123" (tooltip unchanged). */
    .pill.bad .cpuw, .pill.bad .dropw { display: none; }
    /* Room for the "Audio paused" pill; the first click brings MIDI back (it starts audio). */
    .audio-off .midiwrap { display: none; }
  }
  /* Short windows (< 740 px tall): a 40 px bar, so the piano roll keeps
     C2..C5 at 9 px rows at 1280×720 (pianoroll.spec.ts): 36 px transport
     buttons, tempo LCD and timer (BigTimer.svelte), shorter pills. The
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
    .io { gap: 2px; }
    .pill { height: 17px; font-size: 11px; }
    .small .pill { height: 17px; }
    .audio { --pill-h: 17px; }
    .pill.keys { line-height: 17px; }
    /* Hit areas of at least 24 px around the short pills (their look stays 17 px). */
    button.pill, summary.pill { position: relative; }
    button.pill::after, summary.pill::after { content: ''; position: absolute; inset: -4px -2px; }
    button.oct::before { inset: -4px -3px; }
  }
  .fatal { padding: 4px 10px; border-radius: var(--r-sm); background: var(--rec); color: var(--on-color); font-weight: 700; }
  .fatal button { padding: 1px 8px; border: 0; border-radius: var(--r-sm); background: var(--text); color: var(--on-color); font: inherit; cursor: pointer; }
</style>
