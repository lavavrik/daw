<script lang="ts">
  import { flushSync, onDestroy, onMount, untrack } from 'svelte';
  import AudioStatusPill from './ui/AudioStatusPill.svelte';
  import { audioStatus } from './audio/audioStatus';
  import { addClip, playPattern, playSong, seek, setMode, stopTransport, transportPlaying } from './state/song-actions';
  import type { TransportHooks } from './state/song-actions';
  import TopBar from './ui/TopBar.svelte';
  import { noteMidiStatus } from './ui/topStatus';
  import Tooltip from './ui/Tooltip.svelte';
  import Browser from './ui/Browser.svelte';
  import Splitter from './ui/Splitter.svelte';
  import { paneWidths } from './ui/paneWidths.svelte';
  import SongArea from './ui/SongArea.svelte';
  import BottomPanel from './ui/BottomPanel.svelte';
  import { Op, TELEMETRY } from './audio/protocol';
  import { PPQ, createAudioClock } from './audio/audioClock';
  import type { AudioClock } from './audio/audioClock';
  import { AudioEngine } from './audio/engine';
  import { hintLabel, loadLatencyHint, restartAudio, saveLatencyHint } from './audio/restart';
  import type { LatencyHint } from './audio/restart';
  import { Project } from './state/project.svelte';
  import { noPatternReason } from './ui/patternReadout';
  import { addDrumTrack, addRow, liveInputTrack, removeTrack, setRowGain, setRowSample, setStep, stop } from './state/actions';
  import { addSynthTrack, loadPatch, rollbackRefusedAdd } from './state/rack-actions';
  import { addDefaultDrumTrack, appKitDeps, loadDefaultKit } from './state/defaultKit';
  import type { KitDeps } from './state/defaultKit';
  import { library } from './library/library.svelte';
  import { addNote, setPatternBars } from './state/pattern-actions';
  import { setMix, setSidechain } from './state/mixer-actions';
  import { addReturn, deleteReturn, renameReturn } from './state/returns';
  import type { ReturnKind } from './state/returns';
  import { addLane, drawPoints, setLaneEnabled } from './state/automation-actions';
  import { BUILTIN_PATCHES } from './state/patches';
  import { installShortcuts, setShortcutOctave, type PanelTab } from './input/shortcuts';
  import { connectMidi, createMidiHandler } from './input/midi';
  import { loadOctave, saveOctave } from './input/qwertyPiano';
  import { createNoteInput } from './input/noteInput';
  import { dropNotesWhilePaused } from './input/pausedGate';
  import type { NoteInput } from './input/noteInput';
  import { lastLive } from './input/lastNote.svelte';
  import { observeCommand, resetWheels, wheels } from './input/wheels.svelte';
  import { loadRecSettings, recorderFor, sameStatus, transportSync } from './state/recorder';
  import type { Recorder, RecStatus } from './state/recorder';
  import type { MidiStatus } from './input/midi';
  import { banners, flashHint } from './state/banners.svelte';
  import { TEMPLATES, templateById, templateFromUrl } from './state/templates';
  import TemplateStartCard from './ui/TemplateStartCard.svelte';
  import { installSampleLoads, pendingSampleIds, rebindSampleLoads } from './state/sampleLoads';
  import { createProjectSession, markSaved, warningsText } from './project/session';
  import { warnOnUnload } from './project/discard';
  import type { ProjectSession, SessionEngine } from './project/session';
  import { createDirtyCheck } from './project/dirtyCheck';
  import { commandEdits } from './state/edits';
  import { releaseHeldKeys } from './input/shortcuts';
  import {
    createAutosave, createOwnerClaim, discardAutosave, lastExplicitSave, offersRestore, opfsRoot, peekAutosave,
    readAutosave, withAutosaveLock,
  } from './project/autosave';
  import type { AutosaveInfo, LockManagerLike, OwnerClaim } from './project/autosave';
  import { createHistory } from './history/history';
  import type { History } from './history/history';
  import { diffApply } from './history/diffApply';
  import { createGestures, installGestures } from './history/gestures';
  import { cancelOpenConfirms } from './ui/inlineConfirms';
  import { serialize } from './project/serialize';
  import { createAutoBus, provideAutoBus } from './ui/autoBus';
  import { frameLoop } from './ui/vis/frameLoop';
  import { analyserBus } from './ui/vis/analyserBus';
  import { createVisHooks } from './ui/vis/visHooks';
  import { visWake } from './ui/vis/visWake';
  import ValuePopover from './ui/ValuePopover.svelte';
  import { cancelLearn, createCcRouter, learning } from './ui/midiLearn.svelte';
  import { laneView } from './ui/song/laneView.svelte';

  const project = new Project();
  let engine = $state.raw<AudioEngine | null>(null);
  let clock = $state.raw<AudioClock | null>(null);
  let uninstall: (() => void) | null = null;
  let uninstallMidi: (() => void) | null = null;
  let uninstallLoads: (() => void) | null = null;
  let octave = $state(loadOctave());
  /** Every octave change (Z/X or the top bar buttons): state, key handlers, memory. */
  function changeOctave(o: number, fromKeys = false) {
    const n = Math.min(8, Math.max(0, o));
    octave = n;
    if (!fromKeys) setShortcutOctave(n); // Z/X already moved the handlers' own copy
    saveOctave(n);
  }
  let midi = $state<MidiStatus>({ state: 'no-devices', devices: [] });
  /** The last CC received (shown by TopBar, Task 4). */
  let midiCc = $state<{ cc: number; v: number } | null>(null);
  /** Every CC: shown (`midiCc`), then MIDI learn or the mapped control (ccRouter, below). */
  const onCc = (cc: number, v: number) => {
    midiCc = { cc, v };
    ccRouter.onCc(cc, v);
  };
  let recorder = $state.raw<Recorder | null>(null);
  /** The one note bus: QWERTY, MIDI (and later the piano roll) all play through it. */
  let noteInput = $state.raw<NoteInput | null>(null);
  let rec = $state<RecStatus>({ armed: false, state: 'off', canUndoTake: false, takeEdits: 0 });
  /** Undo/redo labels for the top bar's ↶ ↷ (null: nothing to undo / redo). */
  let undoLabels = $state<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  let history = $state.raw<History | null>(null);
  let stopWatch: (() => void) | null = null;
  let session = $state.raw<ProjectSession | null>(null);
  /** The hint the running engine was started with (Settings; persisted on Apply). */
  let latencyHint = $state<LatencyHint>('interactive');
  /** An audio restart (Settings ▸ Apply) is running. */
  let restarting = $state(false);
  /** The top bar: ⌘O goes through its Project menu (the same "Discard and open…" guard). */
  let topBar = $state.raw<{ request(cmd: 'new' | 'open'): void } | null>(null);
  let bottomPanel = $state.raw<{ pickTab(t: PanelTab): void } | null>(null);

  // "● unsaved": every edit command sets project.dirty and bumps
  // project.version (state/edits.ts, via engine.onCommand); once edits pause,
  // the debounced fingerprint check clears it again if the project is back
  // to its saved state. Task 4's autosave subscribes to project.version.
  const dirtyCheck = createDirtyCheck(project);
  $effect(() => {
    void project.version;
    dirtyCheck.poke();
  });
  $effect(() => {
    document.title = `${project.dirty ? '● ' : ''}${project.name} — DAW`;
  });

  // Autosave (project/autosave.ts): to OPFS 5 s after the last edit (the same
  // project.version signal; a load never bumps it) and when the tab is
  // hidden. Held until the start-up check has run, and while the "Restore
  // last session" offer is open, so the previous session is never
  // overwritten before the user chose. Only one tab autosaves (the one
  // holding the owner Web Lock); every OPFS access holds the autosave lock.
  const locks = (navigator as { locks?: LockManagerLike }).locks;
  const locked = <T,>(fn: (root: FileSystemDirectoryHandle) => Promise<T>) =>
    withAutosaveLock(locks, async () => fn(await opfsRoot()));
  let autosaveError: string | null = null;
  const autosave = createAutosave({
    getProject: () => project,
    root: opfsRoot,
    onError: (m) => {
      if (m !== null) banners.error = autosaveError = m;
      else if (banners.error === autosaveError) banners.error = null;
    },
  });
  autosave.hold(true);
  /**
   * The default kit (state/defaultKit.ts): a sample landing after the user
   * edited the session is not an edit (no version bump), but the autosave
   * must still include it.
   */
  const kitDeps: KitDeps = { ...appKitDeps, landedAfterEdit: () => autosave.markDirty() };
  let seenVersion = project.version;
  $effect(() => {
    const v = project.version;
    if (v === seenVersion) return;
    seenVersion = v;
    untrack(() => autosave.markDirty());
  });
  onMount(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void autosave.flush();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  });
  // Unsaved edits to a project with a folder: the browser asks before the tab
  // closes or reloads (project/discard.ts warnOnUnload).
  onMount(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (!warnOnUnload(project)) return;
      e.preventDefault();
      e.returnValue = ''; // older Chrome needs it set
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  });

  /** An autosave newer than the last explicit save, offered in an inline banner (never confirm()). */
  let restoreOffer = $state<AutosaveInfo | null>(null);
  let restoring = false;
  /**
   * The autosave owner lock (only its holder autosaves, offers a restore or
   * deletes the autosave). Claimed at mount, while the engine is still being
   * built (Web Locks need no audio), so `ownerClaim.owns` is settled
   * before any New can run; a tab that is not the owner says so at once.
   */
  let ownerClaim: OwnerClaim | null = null;
  /** Shown for as long as this tab is not the owner (a banner, from mount on). */
  const AUTOSAVE_OFF = 'Autosave is off — this project is open in another tab';
  let autosaveOff = $state(false);
  onMount(() => {
    ownerClaim = createOwnerClaim(locks, {
      // Another tab autosaves (and would offer / discard that session): this
      // one must not overwrite it, nor offer the other tab's live work.
      onNotOwner: () => {
        autosave.disable();
        autosaveOff = true;
      },
    });
  });

  /** Once the engine exists (a restore needs it): offer the autosave if it is newer than the last save. */
  async function checkAutosave() {
    const gen = project.generation; // the session audio started with (before any await)
    if (!ownerClaim || !(await ownerClaim.settled)) return;
    try {
      const info = await locked(peekAutosave);
      // A New / Open meanwhile (it already dropped or deleted that autosave)
      // answered the question: offer nothing.
      if (project.generation === gen && offersRestore(info, lastExplicitSave())) {
        restoreOffer = info;
        return; // stays held until answered
      }
    } catch (e) {
      console.warn('Could not check for an autosave', e);
    }
    autosave.hold(false);
  }

  async function restoreLastSession() {
    if (!session || restoring) return;
    restoring = true;
    const offer = restoreOffer;
    restoreOffer = null;
    try {
      // The read runs inside the session's one-operation guard (with the
      // Loading overlay), so ⌘O cannot start an Open while it reads.
      const done = await session.restore(async () => {
        const saved = await locked(readAutosave);
        if (!saved) throw new Error('the autosave is gone');
        return saved;
      });
      if (done === null) {
        // An Open / Save was still running: nothing happened, ask again.
        restoreOffer = offer;
        return;
      }
      autosave.cancel(); // the restored state is what the autosave holds
      banners.error = null;
      flashHint(`Restored "${project.name}" — not saved to a folder yet`);
    } catch (e) {
      // A load that failed half-way left a blank session: pending edits from
      // before must not autosave it over the session that failed to restore.
      autosave.cancel();
      banners.error = `Couldn't restore the last session — ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      restoring = false;
      if (restoreOffer === null) autosave.hold(false); // still offered: still held
    }
  }

  /** Delete the autosave (it belongs to a session the user discarded). */
  async function deleteAutosave() {
    try {
      await locked(discardAutosave);
    } catch (e) {
      console.warn('Could not remove the autosave', e);
    }
  }

  async function startFresh() {
    restoreOffer = null;
    await deleteAutosave();
    autosave.hold(false);
  }

  /**
   * Project ▸ New built its fresh session (the default kit's drum track, not
   * an edit: no version bump). Like "Start fresh": the discarded session's
   * pending autosave is dropped and its autosave deleted (not overwritten by
   * the untouched New session, which would then be offered back as "Restore
   * last session" on the next start); the first real edit autosaves as
   * usual. Only the owner tab touches the autosave. Then the kit loads (New
   * from template: the template's kit, `kitId`, into its drum track).
   * A `?template=` start-up (urlStart) discards nothing: it is the first
   * session of the page, so an autosave there is the previous visit's work,
   * still to be offered (checkAutosave runs after it).
   */
  let urlStart = false;
  /**
   * The `?template=` template still to open (onstarted), with its start card
   * (ui/TemplateStartCard.svelte) shown until it has. It opens once audio
   * runs: a project load resets the engine, which needs a running context
   * (project/load.ts), so it waits for the first gesture.
   */
  let urlTemplate = $state<{ id: string; name: string; blurb: string } | null>(null);
  let urlTemplateOpening = $state(false);
  $effect(() => {
    const t = urlTemplate;
    const s = session;
    if (!t || !s || ctxState !== 'running') return;
    untrack(() => {
      if (urlTemplateOpening) return;
      urlTemplateOpening = true;
      urlStart = true; // onFresh runs inside newFromTemplate, before it resolves
      void s.newFromTemplate(t.id)
        .finally(() => {
          urlStart = false;
          urlTemplate = null;
          urlTemplateOpening = false;
        })
        .then(checkAutosave);
    });
  });
  function onFresh(trackId: string, kitId?: string) {
    if (!urlStart) {
      autosave.cancel();
      if (ownerClaim?.owns) void deleteAutosave();
    }
    void loadDefaultKit(project, live, trackId, kitDeps, kitId);
  }

  /** "Mar 3, 14:05" (or just "14:05" today). */
  function when(t: number) {
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }

  /**
   * The engine as everything created once per session sees it: the note
   * input, MIDI, shortcuts, recorder, history and project session hold this
   * forwarding view, never an AudioEngine, so an audio restart (Settings ▸
   * Apply, audio/restart.ts), which replaces the engine, needs no re-wiring
   * for them. Components get `engine` as a (reactive) prop instead. Only
   * used once the engine exists.
   */
  const live: SessionEngine = {
    get sampleRate() {
      return engine!.sampleRate;
    },
    get context() {
      return engine!.context;
    },
    send: (op, a, b, c, d) => engine?.send(op, a, b, c, d) ?? false,
    resetAll: () => engine!.resetAll(),
    loadSample: (id, channels) => engine!.loadSample(id, channels),
    ensureRunning: () => engine!.ensureRunning(),
  };
  // Knobs and faders follow automation (ui/autoBus.ts): one rAF loop while
  // playing in Song mode with automatable controls on screen; otherwise a
  // single evaluation whenever something they show may have changed (an
  // edit or undo bumps project.version; Play / Stop, a seek, a mode switch,
  // a load). It reads the CURRENT engine and clock (they change on an audio
  // restart).
  const autoBus = createAutoBus({
    project,
    sink: { send: (op, a, b, c, d) => engine?.send(op, a, b, c, d) ?? false },
    heardTicks: () => clock?.heardTicks() ?? NaN,
    engineTicks: () => engine?.telemetry()[TELEMETRY.ticks] ?? NaN,
    // One 128-frame render quantum in ticks: an override lands at the block after the telemetry's.
    blockTicks: () => (engine ? (128 * project.tempo * PPQ) / (60 * engine.sampleRate) : 0),
    onSuspended: (ids) => (laneView.suspended = ids),
  });
  provideAutoBus(autoBus);
  // MIDI learn and mapped CCs (ui/midiLearn.svelte.ts): learn mode binds the
  // next CC; otherwise one move per mapping per frame through the normal
  // action, overriding an automated target like a drag (autoBus.touch).
  const ccRouter = createCcRouter({
    p: project,
    sink: { send: (op, a, b, c, d) => engine?.send(op, a, b, c, d) ?? false },
    touch: (owner, target) => void autoBus.touch(owner, target),
  });
  // A new clock means a new engine (an audio restart): it has no overrides.
  $effect(() => {
    void clock;
    untrack(() => autoBus.reset());
  });
  // Idle visuals (voice LEDs, analysers: ui/vis/visWake.ts) come back on
  // Play and on any edit (a patch can drone without a note).
  $effect(() => {
    const playing = project.playing;
    untrack(() => visWake().setPlaying(playing));
  });
  $effect(() => {
    void project.version;
    untrack(() => visWake().wake());
  });
  $effect(() => {
    void project.version;
    void project.playing;
    void project.mode;
    void project.songPosition;
    void project.loading;
    void clock;
    untrack(() => autoBus.refresh());
  });

  /** Same for the clock: each engine gets a new one (its telemetry history is per engine). */
  const liveClock: AudioClock = {
    heardTicks: () => clock!.heardTicks(),
    ticksForEvent: (perfMs, offsetMs) => clock!.ticksForEvent(perfMs, offsetMs),
  };

  // Exposed unconditionally (personal local app): e2e tests and the console use it.
  window.__daw = { engine: null, Op, clock: null, recorder: null, project, vis: createVisHooks({ engine: () => engine, loop: frameLoop(), bus: analyserBus() }), actions: {
    // Real song actions for e2e (no-ops before the engine exists).
    addClip: (trackId, o) => (engine ? addClip(project, engine, trackId, o) : null),
    // Song position (as a ruler click does), e.g. a mid-clip seek timed in the audio clips e2e.
    seek: (ticks: number) => engine && seek(project, engine, ticks),
    // Used by the spec 6 perf e2e (tests/e2e/serial.spec.ts) to build its scenario
    // through the same code paths as the UI.
    addDrumTrack: () => (engine ? addDrumTrack(project, engine) : null),
    addSynthTrack: (patchName) =>
      engine ? addSynthTrack(project, engine, undefined, BUILTIN_PATCHES.find((x) => x.name === patchName)) : null,
    addRow: (trackId) => (engine ? addRow(project, engine, trackId) : null),
    // Returns (plan 29): e2e drives them through the same actions as the UI.
    addReturn: (kind: ReturnKind, name?: string) => (engine ? addReturn(project, engine, kind, name) : null),
    renameReturn: (id: string, name: string) => renameReturn(project, id, name),
    deleteReturn: (id: string) => (engine ? deleteReturn(project, engine, id) : false),
    removeTrack: (trackId) => engine && removeTrack(project, engine, trackId),
    setRowSample: (trackId, rowId, sampleId, name) => engine && setRowSample(project, engine, trackId, rowId, sampleId, name),
    setStep: (trackId, rowId, step, vel) => engine && setStep(project, engine, trackId, rowId, step, vel),
    setRowGain: (trackId, rowId, gain) => engine && setRowGain(project, engine, trackId, rowId, gain),
    addNote: (trackId, o) => (engine ? addNote(project, engine, trackId, o) : null),
    // A pattern length the menus don't offer (the Acid e2e's 3 bars).
    setPatternBars: (trackId, bars) => engine && setPatternBars(project, engine, trackId, bars),
    setMix: (target, param, v) => engine && setMix(project, engine, target, param, v),
    setSidechain: (trackId, key) => (engine ? setSidechain(project, engine, trackId, key) : false),
    loadPatch: (trackId, patch) => (engine ? loadPatch(project, engine, trackId, patch) : []),
    // Automation lanes (plan 10 Task 5: the lanes perf scenario and the restart e2e), as the
    // lane header's "+ Lane", a Cmd/Ctrl-drag stroke and the lane's on/off dot do. Returns the lane's id.
    addLane: (owner, target) => (engine ? addLane(project, engine, owner, target)?.id ?? null : null),
    drawLane: (laneId, samples) => engine && drawPoints(project, engine, laneId, samples),
    setLaneEnabled: (laneId, on) => engine && setLaneEnabled(project, engine, laneId, on),
  },
  // The Browser's library (e2e: attach an OPFS folder as start-up would a stored one).
  library,
  // Project save/load with any directory handle (e2e: OPFS). Same code as the Project menu.
  saveTo: (dir) => (session ? session.saveTo(dir) : Promise.reject(new Error('audio not started'))),
  openFrom: (dir) => (session ? session.openFrom(dir) : Promise.reject(new Error('audio not started'))),
  // Project ▸ New without the menu (e2e: New in the very task audio started).
  newProject: () => (session ? session.newProject() : Promise.reject(new Error('audio not started'))),
  // File ▸ New from template ▸ <id> without the menu (e2e).
  newFromTemplate: (id: string) => (session ? session.newFromTemplate(id) : Promise.reject(new Error('audio not started'))),
  autosave,
  history: null,
  // The project as undo / save see it (e2e: the restart's serialize-equality check).
  snapshot: () => serialize(project),
  };

  /**
   * The two transports (plan 20; state/song-actions.ts): the top bar's Play /
   * Stop and Space outside the bottom panel drive the song transport, the
   * bottom panel's pattern transport and Space inside it drive Pattern mode.
   * Starting one stops the other. The recorder hooks: a stop first closes
   * held recorded notes at the heard tick *now* (once STOP lands the engine
   * resets its playhead, so the clock can no longer tell where the user
   * stopped); Pattern Play while armed with Count-in on sends PLAY 3840 (the
   * count-in is asked once the mode is Pattern), and a start begins the
   * recording pass at once (not a telemetry frame later, which could miss a
   * note played right on Play).
   */
  function transportHooks(r: Recorder, c: AudioClock): TransportHooks {
    return { beforeStop: () => r.onTransport(false, c.heardTicks()), countIn: () => r.countInTicks() };
  }
  function startTransport(mode: 'pattern' | 'song') {
    if (!engine || !recorder || !clock || project.loading) return;
    wakeAudio(); // PLAY queues in the ring and sounds once the context runs
    const start = mode === 'song' ? playSong : playPattern;
    // A failed (or closed) engine refuses PLAY: stay stopped, no recording pass.
    if (start(project, engine, transportHooks(recorder, clock))) recorder.onTransport(true, clock.heardTicks());
    refreshRec();
  }
  function stopAny() {
    if (!engine || !recorder || !clock || project.loading) return;
    stopTransport(project, engine, transportHooks(recorder, clock));
    refreshRec();
  }
  /** Why the pattern transport can't run for the selection (its disabled buttons' tooltip), or null. */
  const noPattern = () => noPatternReason(project.tracks.find((x) => x.id === project.selectedTrackId)?.kind ?? null);
  /** Top bar Play / Stop, and Space (stopped) outside the bottom panel. */
  function toggleSong() {
    if (transportPlaying(project, 'song')) stopAny();
    else startTransport('song');
  }
  /** Space (stopped) inside the bottom panel: as the panel's Play (a disabled Play only says why). */
  function togglePattern() {
    if (transportPlaying(project, 'pattern')) stopAny();
    else if (noPattern()) flashHint('Select a drum or synth track to play its pattern');
    else startTransport('pattern');
  }

  /**
   * Does a Space belong to the bottom panel (the pattern transport)? Yes when
   * the key's target or the focused element is inside it. Many panel controls
   * give the focus back after use (the pattern picker, rack selects, number
   * fields blur on commit), leaving it on <body>; then the area used last
   * decides: `lastInPanel` follows every pointerdown and focusin (capture
   * phase, on the window, so nothing can stop it first).
   */
  let bottomEl = $state<HTMLElement | null>(null);
  let songEl = $state<HTMLElement | null>(null);
  let lastInPanel = false;
  const inPanel = (t: EventTarget | null) => !!bottomEl && t instanceof Node && bottomEl.contains(t);
  const inBottomPanel = (t: EventTarget | null) => {
    if (inPanel(t) || inPanel(document.activeElement)) return true;
    const a = document.activeElement;
    return (!a || a === document.body) && lastInPanel;
  };
  onMount(() => {
    const note = (e: Event) => (lastInPanel = inPanel(e.target));
    window.addEventListener('pointerdown', note, true);
    window.addEventListener('focusin', note, true);
    return () => {
      window.removeEventListener('pointerdown', note, true);
      window.removeEventListener('focusin', note, true);
    };
  });

  /**
   * Live-input switches (select, remove, add a synth track — from any code
   * path) reach the recorder here: notes held across the switch end at the
   * heard tick now on the old track, later ones record on the new input.
   * The effect runs in the same task as the change (before the next key event).
   */
  // Entering Song mode (recording disabled there) closes held notes the same way.
  let inputId: string | null = null;
  $effect(() => {
    const id = `${liveInputTrack(project)?.id ?? null}|${project.mode}`;
    if (id === inputId) return;
    inputId = id;
    if (recorder && clock) recorder.onInputChanged(clock.heardTicks());
  });

  /**
   * R / the pattern transport's Rec, with the Rec button's guards (R must
   * not do what the disabled button can't): with no drum or synth track
   * selected it only says why; recording is Pattern-mode only, so while the
   * song plays arming is refused (say so briefly), and stopped in Song mode
   * (the song ran last) arming switches to Pattern mode first, so the next
   * pattern Play records (and counts in). Disarming always works.
   */
  function toggleArm() {
    if (project.loading || !recorder) return;
    const why = recorder.armed ? null : noPattern();
    if (why) {
      flashHint(why);
      return;
    }
    if (project.mode === 'song' && !recorder.armed) {
      if (project.playing) {
        flashHint('Recording works with the pattern transport: stop the song first');
        return;
      }
      if (engine) setMode(project, engine, 'pattern');
    }
    recorder.toggleArm();
    refreshRec();
  }

  function refreshRec() {
    const s = recorder?.status();
    if (s && !sameStatus(s, rec)) rec = s;
  }

  /**
   * 60 Hz: keeps the recorder's transport state in step with the engine
   * (transportSync: the safety net for starts/stops the UI did not make; 4 Hz
   * would close notes up to 250 ms late; it also writes early drum hits once
   * their step has been heard, Recorder.onHeard) and the Rec button's status
   * fresh (count-in -> recording).
   */
  function watchTransport(e: AudioEngine, c: AudioClock, r: Recorder) {
    const sync = transportSync(r);
    const heard = () => c.heardTicks();
    let raf = 0;
    const loop = () => {
      sync(e.telemetry()[TELEMETRY.playing] === 1, project.playing, heard);
      refreshRec();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }

  /**
   * Everything that runs against one particular engine: at start, and again
   * for the new engine after an audio restart (unwireEngine detaches the old
   * one first). `codes`: on a restart, the re-uploaded samples' results
   * (deferred sample loads settle from them).
   */
  /**
   * A ring backlog that does not drain means UI and engine disagree until it
   * does: say so. Per engine; returns the detach (which clears its banner).
   */
  function watchStalls(e: AudioEngine): () => void {
    let msg: string | null = null;
    e.onCommandStall = (m) => {
      if (m !== null) banners.error = msg = m;
      else if (banners.error === msg) banners.error = null;
    };
    return () => {
      e.onCommandStall = undefined;
      if (msg !== null && banners.error === msg) banners.error = null;
    };
  }
  /** The running engine's stall watch; and one set up on a restart's new engine before its replay. */
  let unwatchStalls: (() => void) | null = null;
  let preparedStalls: (() => void) | null = null;

  function wireEngine(e: AudioEngine, codes?: Map<number, number>) {
    engine = e;
    window.__daw.engine = e;
    // The audio pill follows this engine's context ('suspended' until the
    // first gesture lets it run).
    ctxState = e.state;
    e.onStateChange = (st) => {
      ctxState = st;
      if (st === 'running') audioError = null; // a retry (or the next gesture) worked
    };
    // The one frame loop for every visual serves this engine's visSab.
    frameLoop().attach(e);
    // The analysers follow its sample rate (the loop re-sends their strip tap).
    analyserBus().attach(e);
    visWake().wake(); // a new engine: idle visuals look again
    unwatchStalls = preparedStalls ?? watchStalls(e);
    preparedStalls = null;
    // Telemetry history (heard time) is per engine: a new clock, which the
    // components get as a prop and the recorder through liveClock.
    clock = createAudioClock(e, () => project.tempo);
    window.__daw.clock = clock;
    // The engine refused a pooled effect (FX pool full): undo it in the UI.
    e.onRackAddRefused = (slot, idx, kind) => {
      const msg = rollbackRefusedAdd(project, slot, idx, kind);
      if (msg !== null) banners.error = msg;
    };
    // Every edit command marks the project dirty (state/edits.ts); bend /
    // mod / reset move the on-screen wheels (input/wheels.svelte.ts). A new
    // engine starts with both wheels at rest.
    resetWheels();
    window.__daw.wheels = wheels; // e2e: the wheels' state after the strip unmounts
    e.onCommand = (op, a) => {
      commandEdits(project, op);
      observeCommand(op, a);
    };
    // Session-lifetime: deferred sample loads must land even while the step
    // grid is unmounted (a synth track selected). A restart moves them over.
    if (codes) rebindSampleLoads(e, codes);
    else uninstallLoads = installSampleLoads(project, e);
    stopWatch = watchTransport(e, clock, recorder!);
  }

  /** Detach the per-engine loops from an engine about to close (audio restart). */
  function unwireEngine() {
    if (engine) engine.onStateChange = undefined; // its context closes next: not the pill's business
    frameLoop().attach(null);
    analyserBus().attach(null);
    stopWatch?.();
    stopWatch = null;
    unwatchStalls?.();
    unwatchStalls = null;
  }

  function onstarted(e: AudioEngine) {
    latencyHint = e.latencyHint;
    // The fresh session: the default kit's drum track (state/defaultKit.ts),
    // its samples loaded once everything below is wired. A `?template=<id>`
    // URL (state/templates.ts templateFromUrl) opens that template instead,
    // once the session exists (below).
    const fromUrl = templateFromUrl(location.search);
    const startTemplate = fromUrl && 'id' in fromUrl ? fromUrl.id : null;
    const kitTrack = startTemplate ? null : addDefaultDrumTrack(project, e);
    markSaved(project); // a fresh session has nothing to save yet
    const r = recorderFor(project, live, liveClock, () => {
      banners.error = 'Pattern is full (1024 notes): some recorded notes were dropped';
    });
    const saved = loadRecSettings();
    r.countIn = saved.countIn;
    r.offsetMs = saved.offsetMs;
    recorder = r;
    window.__daw.recorder = r;
    // Before a track's current pattern changes (selectPattern): held recorded
    // notes are written into the old pattern while the engine still edits it.
    project.beforePatternSwitch = (trackId) => r.onPatternChanging(trackId, liveClock.heardTicks());
    // A played note-on wakes the idle visuals and is the last live note
    // (the Sample Player's "Root ← last note"; the Acid tab's step entry
    // watches the count).
    // While audio is paused (no gesture yet) played notes are dropped, not
    // queued to burst out on the first click (input/pausedGate.ts).
    const input = createNoteInput(dropNotesWhilePaused(live, () => engine?.state === 'running'), r, (note) => {
      wakeAudio(); // a MIDI note is no gesture: it may still be paused
      lastLive.note = note;
      lastLive.seq++;
      visWake().wake();
    });
    noteInput = input;
    wireEngine(e);
    // Undo/redo (history/history.ts): every action is a transact, every
    // pointer gesture one entry (installGestures), restored by diffApply
    // through the engine sink, so dirty marking and autosave see it.
    const h = createHistory({
      snapshot: () => serialize(project),
      apply: (from, to) => diffApply(project, live, from, to),
      canApply: () => !project.loading,
      // Held recorded notes close now: they belong to the pass being undone.
      beforeApply: () => r.onInputChanged(liveClock.heardTicks()),
      onChange: () => {
        undoLabels = h.labels;
        refreshRec();
      },
      coalesceTask: true,
    });
    project.history = h;
    history = h;
    window.__daw.history = h;
    // New / Open replace the session: stop through the normal path first (the
    // recorder closes held notes at the heard tick) and release held keys.
    const s = createProjectSession(project, live, {
      // Right before the engine is reset (after the file validated and the
      // samples decoded): stop like the Stop button does, so the recorder
      // closes held notes at the heard tick; release held piano keys.
      beforeLoad: () => {
        // A New / Open while the restore offer is open answers it (the user
        // confirmed "Discard the unrestored session … Its autosave will be
        // deleted", project/discard.ts): that project replaces the session.
        if (restoreOffer && !restoring) {
          restoreOffer = null;
          void deleteAutosave();
          autosave.hold(false);
        }
        if (project.playing) {
          r.onTransport(false, liveClock.heardTicks());
          stop(project, live);
        }
        releaseHeldKeys();
      },
      // The live input and the tracks changed under the recorder: retarget
      // now (Undo take follows), and disarm if the project opened in Song mode.
      afterLoad: () => {
        r.onInputChanged(liveClock.heardTicks());
        if (project.mode === 'song' && r.armed) r.toggleArm();
        refreshRec();
      },
      // Project ▸ Save / Save As: an older autosave is now stale, and a
      // pending one is dropped unless edits (or default-kit samples) landed
      // during the write.
      onSaved: ({ version, baselineEpoch, t }) =>
        autosave.savedExplicitly(t, project.version === version && project.baselineEpoch === baselineEpoch),
      // Project ▸ New: drop the old session's autosave, fill the kit.
      onFresh,
    });
    session = s;
    // After audio started: a restore needs the engine. A URL template opens
    // first (the urlTemplate effect, once audio runs), so the autosave offer
    // still comes after it (checkAutosave skips the offer when the session
    // changed under it), and it keeps the autosave (onFresh, urlStart).
    const t = startTemplate ? templateById(startTemplate) : undefined;
    if (t) urlTemplate = { id: t.id, name: t.name, blurb: t.blurb };
    else void checkAutosave();
    if (fromUrl && 'unknown' in fromUrl) {
      banners.error = `No template "${fromUrl.unknown}" (templates: ${TEMPLATES.map((t) => t.id).join(', ')})`;
    }
    uninstall = installShortcuts(project, live, input, {
      initialOctave: octave,
      onOctave: (o) => changeOctave(o, true),
      onToggleSong: toggleSong,
      onTogglePattern: togglePattern,
      inBottomPanel,
      onToggleArm: toggleArm,
      onSave: () => void s.save(),
      onSaveAs: () => void s.saveAs(),
      onOpen: () => topBar?.request('open'),
      onUndo: undo,
      onRedo: redo,
      pointerDown: () => gestures.pointerDown(),
      onTab: (t) => bottomPanel?.pickTab(t),
      // Space while playing: stop through the recorder hooks (beforeStop
      // closes held recorded notes at the heard tick), as the Stop buttons.
      onStop: stopAny,
    });
    // Not awaited: the permission prompt must never block startup/rendering.
    // Bound to `live`, so it outlives an audio restart as is.
    // noteMidiStatus first: a granted status forgets a dismissed "MIDI
    // blocked" badge (ui/topStatus.ts) before TopBar re-reads it.
    void connectMidi(live, input, (s) => { noteMidiStatus(s); midi = s; }, onCc).then((d) => (uninstallMidi = d));
    // Test hook: same sink / input / onCc as a real input, source `midi:inject`.
    const injector = createMidiHandler(live, input, onCc);
    window.__daw.midi = { inject: (bytes) => injector.handle('midi:inject', Uint8Array.from(bytes), performance.now()) };
    // Not awaited either: rows fill as the kit's samples land. A restore
    // accepted meanwhile replaces the session and ends it (Project.generation).
    if (kitTrack) void loadDefaultKit(project, live, kitTrack.id, kitDeps);
  }

  // ---- start-up (no splash) ----------------------------------------------
  // The engine is built at page load, before any gesture: the AudioContext
  // starts 'suspended' and the UI renders as soon as the engine object exists
  // (a few hundred ms; until then nothing renders, so no control can act on
  // a missing engine). The audio pill (TopBar, audio/audioStatus.ts) says
  // "Audio paused — click anywhere to start" until the context runs.
  /** The current engine's AudioContext state (its statechange events). */
  let ctxState = $state<AudioContextState | null>(null);
  /** Why building the engine, or resuming its context, failed (the pill's tooltip). */
  let audioError = $state<string | null>(null);
  const audio = $derived(audioStatus({ engine: !!engine, state: ctxState, error: audioError }));
  let building = false;
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /**
   * Build the engine and run the normal start-up on it (onstarted). Also the
   * failed pill's retry. Only the build can fail as "Audio failed": an
   * exception in onstarted is a bug and surfaces as one (unhandled), never
   * as a retryable audio failure over a half-done start-up.
   */
  async function startEngine() {
    if (building || engine) return;
    building = true;
    audioError = null;
    let e: AudioEngine;
    try {
      e = await AudioEngine.start({ latencyHint: loadLatencyHint() });
    } catch (err) {
      console.error('Audio could not start', err);
      audioError = errText(err);
      return;
    } finally {
      building = false;
    }
    onstarted(e);
  }
  onMount(() => void startEngine());

  /**
   * Ask the context to run: every gesture (below) and every path that plays
   * (Play, notes, the sample preview) call it. Not awaited: without a
   * gesture yet Chrome keeps it pending. A refusal (no output device) turns
   * the pill into "Audio failed — retry".
   */
  function wakeAudio() {
    const e = engine;
    if (!e || e.state === 'running') return;
    e.resume().catch((err: unknown) => {
      if (engine === e) audioError = errText(err);
    });
  }

  /**
   * The pill's click (and Options ▸ Audio settings… while paused): retry a
   * failed start, else resume. Resolves once audio runs (or failed), with
   * the pill already updated, so a caller can open what the running state
   * shows (TopBar: the Audio settings dialog).
   */
  async function resumeAudio(): Promise<void> {
    if (!engine) return startEngine();
    audioError = null;
    const e = engine;
    try {
      await e.resume();
    } catch (err) {
      if (engine === e) audioError = errText(err);
      return;
    }
    if (engine === e) ctxState = e.state; // don't wait for the statechange event
  }

  /**
   * Settings ▸ Apply: a new AudioContext + engine with `hint`, the project
   * restored onto it from memory (audio/restart.ts). The old engine keeps
   * running until the new one is up; any failure (refused, 8 s timeout)
   * keeps it and says "Couldn't apply …; kept previous settings". Runs as
   * one project operation (session.exclusive: never during an Open / Save /
   * restore), and never during an export (it decodes with the live context).
   * Resolves with a message for the panel, or null.
   */
  async function applyAudioSettings(hint: LatencyHint): Promise<string | null> {
    const old = engine;
    const r = recorder;
    if (!old || !r || !session || restarting) return null;
    if (banners.exporting) return 'Wait for the export to finish, then Apply again';
    restarting = true;
    try {
      const res = await session.exclusive(() =>
        restartAudio(project, hint, {
          old,
          oldHint: latencyHint,
          start: (h) => AudioEngine.start({ latencyHint: h, untilRunning: true }),
          flush: () => autosave.flush(),
          // Applying stops the transport (plan 7): through the Stop path, so
          // the recorder closes held notes at the heard tick.
          stop: () => {
            if (project.playing) {
              r.onTransport(false, liveClock.heardTicks());
              stop(project, live);
            }
            // Whatever stopped it, a recording pass's undo hold ends with the
            // restart (a pass cannot outlive its engine); harmless if none.
            project.history?.release();
            releaseHeldKeys();
            refreshRec();
          },
          prepare: (e) => (preparedStalls = watchStalls(e)),
          unwire: unwireEngine,
          wire: (e, codes) => wireEngine(e, codes),
          // Deferred loads still waiting: uploaded with the used samples, settled at wire.
          inFlight: pendingSampleIds,
        }),
      );
      if (res === undefined || res === null) return 'Busy with a project load or save — Apply again when it is done';
      if (res.error) {
        // The new engine was closed; its stall watch goes with it.
        preparedStalls?.();
        preparedStalls = null;
        banners.error = res.error;
        return res.error;
      }
      latencyHint = res.hint;
      saveLatencyHint(res.hint);
      r.onInputChanged(liveClock.heardTicks());
      refreshRec();
      banners.load = res.warnings.length ? warningsText('Audio restarted — skipped or changed', res.warnings) : null;
      if (!res.warnings.length) flashHint(`Audio restarted (${hintLabel(res.hint)})`);
      // The unused samples upload after the switch (undo may need them): their
      // warnings join the same banner, unless the session was replaced meanwhile.
      // ...nor by a later restart (its own banner wins).
      const gen = project.generation;
      const restarts = project.audioRestarts;
      void res.later.then((w) => {
        if (w.length && project.generation === gen && project.audioRestarts === restarts) {
          banners.load = warningsText('Audio restarted — skipped or changed', [...res.warnings, ...w]);
        }
      });
      return null;
    } catch (e) {
      // Not an audio failure (restartAudio reports those): a bug. Say so; the
      // old engine is still the wired one unless wiring itself threw.
      const msg = `Couldn't apply ${hintLabel(hint)}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(msg, e);
      banners.error = msg;
      return msg;
    } finally {
      restarting = false;
    }
  }

  // Every pointer gesture is one undo entry (history/gestures.ts: lost
  // pointerups after a <select> popup or a context menu end it too).
  const gestures = createGestures({ history: () => history, loading: () => project.loading });
  onMount(() => installGestures(gestures));
  /**
   * ⌘Z / ↶ and ⇧⌘Z / ↷. During a drag (a knob, fader, automation point,
   * clip handle ... registered with registerDragCancel) the key cancels the
   * drag instead, as Escape would: the pre-drag value back, no entry, nothing
   * older undone (history/gestures.ts cancelDrag). Any other held press
   * continues as a new entry after the undo.
   * An open inline confirm is cancelled first, exactly like its Cancel
   * (ui/inlineConfirms.ts: it asked about a state the undo replaces); the
   * flush closes it (and returns focus to its anchor) before the undo applies.
   */
  const closeConfirms = () => {
    if (cancelOpenConfirms()) flushSync();
  };
  const undo = () => {
    if (gestures.cancelDrag()) return;
    closeConfirms();
    history?.undo();
    gestures.afterApply();
  };
  const redo = () => {
    if (gestures.cancelDrag()) return;
    closeConfirms();
    history?.redo();
    gestures.afterApply();
  };

  // Audio starts on the first gesture (no start splash: spec 2026-11-15
  // §10, docs/architecture/audio-path.md "Start-up"): every pointerdown /
  // keydown, in the capture phase (nothing can stop it first), asks the
  // context to resume, and the event still goes on to its target: a first
  // click on Play both starts audio and plays. Cheap once running; it also
  // wakes a context the browser suspended later (device change, long idle),
  // the "click to start audio" a paused project load asks for (load.ts).
  onMount(() => {
    const wake = () => wakeAudio();
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    // A key right after a click is its own entry, not part of the click's
    // gesture (its commit is still a task away; history/gestures.ts
    // commitReleased). Capture phase: before any handler edits.
    const keyCommit = () => gestures.commitReleased();
    window.addEventListener('keydown', keyCommit, true);
    // Esc ends MIDI learn. Bubble phase: an Esc a widget handles and stops
    // (stopPropagation: an open menu, a typed knob value, a mid-drag cancel)
    // is that widget's and leaves learn mode on. So is one another listener
    // already handled (defaultPrevented; an open menu-bar menu, MenuBar.svelte,
    // closes on a document keydown and also stops it).
    const escLearn = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && learning()) cancelLearn();
    };
    window.addEventListener('keydown', escLearn);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
      window.removeEventListener('keydown', keyCommit, true);
      window.removeEventListener('keydown', escLearn);
    };
  });

  onDestroy(() => {
    dirtyCheck.dispose();
    autosave.dispose();
    stopWatch?.();
    uninstall?.();
    uninstallMidi?.();
    uninstallLoads?.();
  });

  // Window-level drop guard. A file dropped where no row handles it (Browser
  // pane, gaps, headers, a disabled button, the page before the engine
  // exists) would make the browser navigate to the file and lose the
  // session. Rows/"+ Add row" call preventDefault themselves; anything still
  // un-prevented when the event bubbles here is a miss: cancel it and say
  // where to drop instead.
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  onMount(() => {
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (!e.defaultPrevented) banners.error = 'Drop onto a step-grid row, "+ Add row", a Sample Player, or the timeline (an audio track, or below the tracks) to load a sample';
      e.preventDefault();
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });
</script>

<div class="app">
  {#if engine}
    {#if recorder && session}
      <TopBar
        bind:this={topBar}
        p={project} {engine} {octave} onOctave={(o) => changeOctave(o)} {midi} {midiCc} {recorder} {rec} {session} {restoreOffer} {undoLabels}
        {clock} onToggleSong={toggleSong} onStop={stopAny}
        onUndo={undo} onRedo={redo}
        {latencyHint} {restarting} onApplyAudio={applyAudioSettings}
        onTab={(t) => bottomPanel?.pickTab(t)}
        {audio} onAudioResume={resumeAudio}
      />
    {/if}
  {:else}
    <!-- No engine (yet), so no top bar: a bare bar says "Starting audio…"
         while it is built (a hanging start is not a blank page), or holds the
         failed pill's retry. -->
    <header class="bare">
      <span data-testid="audio-status" data-state={audio.kind}><AudioStatusPill status={audio} onresume={() => void resumeAudio()} /></span>
    </header>
  {/if}
  {#if autosaveOff}
    <div class="autosave-off" data-testid="autosave-off" role="status">{AUTOSAVE_OFF}</div>
  {/if}
  {#if engine}
    {#if urlTemplate}
      <TemplateStartCard name={urlTemplate.name} blurb={urlTemplate.blurb} loading={urlTemplateOpening} />
    {/if}
    {#if restoreOffer}
      {@const offer = restoreOffer}
      <div class="restore" data-testid="restore" role="region" aria-label="Restore last session">
        <span>Unsaved work from your last session: <b>{offer.name}</b> (autosaved {when(offer.savedAt)}).</span>
        <button class="ok" onclick={() => void restoreLastSession()}>Restore last session</button>
        <button onclick={() => void startFresh()}>Start fresh</button>
      </div>
    {/if}
    <div class="main" style:--lib-w="{paneWidths.library}px">
      <Browser {engine} p={project} />
      <!-- The library's right edge: drag to resize it (ui/Splitter.svelte; a UI preference). -->
      <Splitter pane="library" label="Library width" testid="library-resize" style="top: 3px; bottom: 3px; left: calc(var(--lib-w) + 2px); width: 5px" />
      <div class="right" class:sized={paneWidths.song > 0} style:--song-h="{paneWidths.song}px">
        <div class="song" bind:this={songEl}><SongArea p={project} {engine} {clock} /></div>
        <div class="bottom" bind:this={bottomEl}>
          <!-- The song area's bottom edge: drag to resize the split (plan 30; ui/Splitter.svelte, a UI preference). -->
          <Splitter
            pane="song" axis="y" label="Tracks height" testid="song-resize" measure={() => songEl?.getBoundingClientRect().height ?? 0}
            style="left: 0; right: 0; top: -5px"
          />
          <BottomPanel
            bind:this={bottomPanel} p={project} {engine} {clock} {noteInput} capturing={() => !!recorder?.armed && project.playing}
            {recorder} {rec} onPatternPlay={() => startTransport('pattern')} onPatternStop={() => { if (transportPlaying(project, 'pattern')) stopAny(); }} onToggleArm={toggleArm}
          />
        </div>
      </div>
    </div>
    <ValuePopover p={project} {engine} bus={autoBus} />
  {/if}
</div>
<Tooltip />
{#if project.loading}
  <!-- A New / Open is replacing the session: no clicks, drags or drops reach
       the editors until it is done (keys are ignored in shortcuts.ts). -->
  <div
    class="loading" data-testid="loading" role="status" aria-live="polite"
    ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()}
  >{restarting ? 'Restarting audio…' : 'Loading…'}</div>
{/if}

<style>
  /* The inherited size is --fs-ctl (12 px), not --fs-body: today's components
     inherit it and are sized for 12 px (at 13 px the top bar wraps at 1400 px
     and the piano roll loses a row). Body text opts into --fs-body as each
     component moves onto the theme. */
  :global(html, body) { margin: 0; height: 100%; background: var(--work); color: var(--text); font: var(--fs-ctl)/1.4 var(--font-ui); }
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--work); }
  /* --lib-w: the library's width (ui/paneWidths.svelte.ts; the Splitter over the 3 px gap resizes it). */
  .main { position: relative; flex: 1; min-height: 0; display: grid; grid-template-columns: var(--lib-w) minmax(0, 1fr); gap: 3px; padding: 3px; }
  /* The editor (piano roll / step grid / rack) gets the larger share: the roll
     needs C2..C5 at >= 9 px rows to show note names (anti-goal: what's where). */
  .right { display: grid; grid-template-rows: minmax(140px, 0.5fr) minmax(380px, 1.5fr); gap: 3px; min-height: 0; min-width: 0; }
  /* Dragged (plan 30: the Splitter on the bottom panel's top edge): the song
     area takes the stored height, kept between 100 px and what leaves the
     bottom panel 200 px. */
  .right.sized { grid-template-rows: clamp(100px, var(--song-h), max(100px, calc(100% - 203px))) minmax(0, 1fr); }
  .song, .bottom { display: grid; min-height: 0; min-width: 0; }
  .bottom { position: relative; }
  /* Banners (plan 20: tokens): the restore offer is an --accent-tinted --panel, the autosave note a quiet --panel line. */
  .restore { display: flex; align-items: center; gap: 8px; margin: 3px 3px 0; padding: 5px 8px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--accent) 14%, var(--panel)); color: var(--text); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--panel)); }
  .restore span { flex: 1; }
  .bare { display: flex; justify-content: flex-end; align-items: center; min-height: 40px; padding: 0 12px; background: var(--top); border-bottom: 1px solid var(--line); }
  .autosave-off { margin: 3px 3px 0; padding: 3px 8px; border-radius: var(--r-sm); background: var(--panel); color: var(--text-2); border: 1px solid var(--line); }
  .restore button { font: inherit; border: 1px solid currentColor; border-radius: var(--r-sm); padding: 1px 8px; background: transparent; color: inherit; cursor: pointer; }
  .restore .ok { background: var(--accent) var(--gloss); color: var(--on-color); border-color: var(--accent); font-weight: 600; }
  .loading { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: color-mix(in srgb, var(--lcd) 60%, transparent); color: var(--text); font-size: 14px; cursor: progress; }
</style>
