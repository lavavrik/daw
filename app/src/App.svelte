<script lang="ts">
  import { flushSync, onDestroy, onMount, untrack } from 'svelte';
  import StartOverlay from './ui/StartOverlay.svelte';
  import { addClip, seek } from './state/song-actions';
  import TopBar from './ui/TopBar.svelte';
  import Browser from './ui/Browser.svelte';
  import SongArea from './ui/SongArea.svelte';
  import BottomPanel from './ui/BottomPanel.svelte';
  import { Op, TELEMETRY } from './audio/protocol';
  import { PPQ, createAudioClock } from './audio/audioClock';
  import type { AudioClock } from './audio/audioClock';
  import { AudioEngine } from './audio/engine';
  import { hintLabel, restartAudio, saveLatencyHint } from './audio/restart';
  import type { LatencyHint } from './audio/restart';
  import { Project } from './state/project.svelte';
  import { addDrumTrack, addRow, liveInputTrack, play, removeTrack, setRowGain, setRowSample, setStep, stop } from './state/actions';
  import { addSynthTrack, loadPatch, rollbackRefusedAdd } from './state/rack-actions';
  import { addDefaultDrumTrack, appKitDeps, loadDefaultKit } from './state/defaultKit';
  import type { KitDeps } from './state/defaultKit';
  import { library } from './library/library.svelte';
  import { addNote, setPatternBars } from './state/pattern-actions';
  import { setMix, setSidechain } from './state/mixer-actions';
  import { addLane, drawPoints, setLaneEnabled } from './state/automation-actions';
  import { BUILTIN_PATCHES } from './state/patches';
  import { installShortcuts, setShortcutOctave, type PanelTab } from './input/shortcuts';
  import { connectMidi, createMidiHandler } from './input/midi';
  import { loadOctave, saveOctave } from './input/qwertyPiano';
  import { createNoteInput } from './input/noteInput';
  import type { NoteInput } from './input/noteInput';
  import { lastLive } from './input/lastNote.svelte';
  import { observeCommand, resetWheels, wheels } from './input/wheels.svelte';
  import { loadRecSettings, recorderFor, sameStatus, transportSync } from './state/recorder';
  import type { Recorder, RecStatus } from './state/recorder';
  import type { MidiStatus } from './input/midi';
  import { banners, flashHint } from './state/banners.svelte';
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
  import AutoMenu from './ui/AutoMenu.svelte';
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
   * deletes the autosave). Claimed at mount, before the start overlay is
   * clicked (Web Locks need no audio), so `ownerClaim.owns` is settled
   * before any New can run; a tab that is not the owner says so at once.
   */
  let ownerClaim: OwnerClaim | null = null;
  /** Shown for as long as this tab is not the owner (on the start overlay too). */
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

  /** After audio started (a restore needs the engine): offer the autosave if it is newer than the last save. */
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
   * usual. Only the owner tab touches the autosave. Then the kit loads.
   */
  function onFresh(trackId: string) {
    autosave.cancel();
    if (ownerClaim?.owns) void deleteAutosave();
    void loadDefaultKit(project, live, trackId, kitDeps);
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
   * used once audio has started.
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
    // Real song actions for e2e (no-ops before audio starts).
    addClip: (trackId, o) => (engine ? addClip(project, engine, trackId, o) : null),
    // Song position (as a ruler click does), e.g. a mid-clip seek timed in the audio clips e2e.
    seek: (ticks: number) => engine && seek(project, engine, ticks),
    // Used by the spec 6 perf e2e (tests/e2e/serial.spec.ts) to build its scenario
    // through the same code paths as the UI.
    addDrumTrack: () => (engine ? addDrumTrack(project, engine) : null),
    addSynthTrack: (patchName) =>
      engine ? addSynthTrack(project, engine, undefined, BUILTIN_PATCHES.find((x) => x.name === patchName)) : null,
    addRow: (trackId) => (engine ? addRow(project, engine, trackId) : null),
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
  autosave,
  history: null,
  // The project as undo / save see it (e2e: the restart's serialize-equality check).
  snapshot: () => serialize(project),
  };

  /**
   * Play / Stop for the button and Space. Play while armed with Count-in on
   * sends PLAY 3840, and starts the recording pass at once (not a telemetry
   * frame later, which could miss a note played right on Play). Stop first
   * closes held recorded notes at the heard tick *now*: once STOP lands the
   * engine resets its playhead to 0, so the clock can no longer tell where
   * the user stopped.
   */
  function transportToggle() {
    if (!engine || !recorder || !clock || project.loading) return;
    if (project.playing) {
      recorder.onTransport(false, clock.heardTicks());
      stop(project, engine);
    } else {
      // A failed (or closed) engine refuses PLAY: stay stopped, no recording pass.
      if (!play(project, engine, recorder.countInTicks())) return;
      recorder.onTransport(true, clock.heardTicks());
    }
    refreshRec();
  }

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

  /** R / Rec button. Song mode can't arm (recording is Pattern-mode only): say so briefly. */
  function toggleArm() {
    if (project.loading) return;
    if (recorder && project.mode === 'song' && !recorder.armed) {
      flashHint('Recording works in Pattern mode (Shift+L)');
      return;
    }
    recorder?.toggleArm();
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
    // its samples loaded once everything below is wired.
    const kitTrack = addDefaultDrumTrack(project, e);
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
    const input = createNoteInput(live, r, (note) => {
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
    void checkAutosave(); // after audio started: a restore needs the engine
    uninstall = installShortcuts(project, live, input, {
      initialOctave: octave,
      onOctave: (o) => changeOctave(o, true),
      onTogglePlay: transportToggle,
      onToggleArm: toggleArm,
      onSave: () => void s.save(),
      onSaveAs: () => void s.saveAs(),
      onOpen: () => topBar?.request('open'),
      onUndo: undo,
      onRedo: redo,
      pointerDown: () => gestures.pointerDown(),
      onTab: (t) => bottomPanel?.pickTab(t),
    });
    // Not awaited: the permission prompt must never block startup/rendering.
    // Bound to `live`, so it outlives an audio restart as is.
    void connectMidi(live, input, (s) => (midi = s), onCc).then((d) => (uninstallMidi = d));
    // Test hook: same sink / input / onCc as a real input, source `midi:inject`.
    const injector = createMidiHandler(live, input, onCc);
    window.__daw.midi = { inject: (bytes) => injector.handle('midi:inject', Uint8Array.from(bytes), performance.now()) };
    // Not awaited either: rows fill as the kit's samples land. A restore
    // accepted meanwhile replaces the session and ends it (Project.generation).
    if (kitTrack) void loadDefaultKit(project, live, kitTrack.id, kitDeps);
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
          start: (h) => AudioEngine.start({ latencyHint: h }),
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

  // The browser may suspend the AudioContext (device change, long idle);
  // resume() needs a user gesture, so every click / key press wakes it. This
  // is the "click to start audio" a paused project load asks for (load.ts).
  onMount(() => {
    const wake = () => {
      if (engine?.context.state === 'suspended') void engine.ensureRunning();
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    // Esc ends MIDI learn. Bubble phase: an Esc a widget handles and stops
    // (stopPropagation: an open menu, a typed knob value, a mid-drag cancel)
    // is that widget's and leaves learn mode on.
    const escLearn = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && learning()) cancelLearn();
    };
    window.addEventListener('keydown', escLearn);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
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
  // pane, gaps, headers, a disabled button, the start overlay) would make the
  // browser navigate to the file and lose the session. Rows/"+ Add row" call
  // preventDefault themselves; anything still un-prevented when the event
  // bubbles here is a miss: cancel it and say where to drop instead.
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
        onTogglePlay={transportToggle} onToggleArm={toggleArm}
        onUndo={undo} onRedo={redo}
        {latencyHint} {restarting} onApplyAudio={applyAudioSettings}
      />
    {/if}
    {#if autosaveOff}
      <div class="autosave-off" data-testid="autosave-off" role="status">{AUTOSAVE_OFF}</div>
    {/if}
    {#if restoreOffer}
      {@const offer = restoreOffer}
      <div class="restore" data-testid="restore" role="region" aria-label="Restore last session">
        <span>Unsaved work from your last session: <b>{offer.name}</b> (autosaved {when(offer.savedAt)}).</span>
        <button class="ok" onclick={() => void restoreLastSession()}>Restore last session</button>
        <button onclick={() => void startFresh()}>Start fresh</button>
      </div>
    {/if}
    <div class="main">
      <Browser {engine} p={project} />
      <div class="right">
        <div class="song"><SongArea p={project} {engine} {clock} /></div>
        <div class="bottom"><BottomPanel bind:this={bottomPanel} p={project} {engine} {clock} {noteInput} capturing={() => !!recorder?.armed && project.playing} /></div>
      </div>
    </div>
    <AutoMenu p={project} {engine} bus={autoBus} />
  {/if}
</div>
{#if !engine}
  <StartOverlay {onstarted} note={autosaveOff ? AUTOSAVE_OFF : null} />
{/if}
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
  .main { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px 1fr; gap: 3px; padding: 3px; }
  /* The editor (piano roll / step grid / rack) gets the larger share: the roll
     needs C2..C5 at >= 9 px rows to show note names (anti-goal: what's where). */
  .right { display: grid; grid-template-rows: minmax(140px, 0.5fr) minmax(380px, 1.5fr); gap: 3px; min-height: 0; min-width: 0; }
  .song, .bottom { display: grid; min-height: 0; min-width: 0; }
  .restore { display: flex; align-items: center; gap: 8px; margin: 3px 3px 0; padding: 5px 8px; border-radius: 3px; background: #2b2a1c; color: #ffd98a; border: 1px solid #5a512b; }
  .restore span { flex: 1; }
  .autosave-off { margin: 3px 3px 0; padding: 3px 8px; border-radius: 3px; background: #23242a; color: #9a9da8; border: 1px solid #33353d; }
  .restore button { font: inherit; border: 1px solid currentColor; border-radius: 3px; padding: 1px 8px; background: transparent; color: inherit; cursor: pointer; }
  .restore .ok { background: #f0a23a; color: #111; border-color: #f0a23a; font-weight: 600; }
  .loading { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: #16171b99; color: #e4e5ea; font-size: 14px; cursor: progress; }
</style>
