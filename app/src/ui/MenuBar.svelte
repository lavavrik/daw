<script lang="ts">
  // The menu bar (plan 21 Task 3; spec 2026-11-15-redesign-round-2 §1):
  //
  //   File · Edit · Add · Patterns · View · Options · Help
  //
  // a row of compact text buttons at the top of the top bar's left block
  // (TopBar.svelte; the project name and the hint line sit under it). It
  // replaces plan 20's ⋯ menu: every ⋯ item moved here with its test id
  // (File: project-new / -open / -save / -save-as / -export, undo-take, the
  // discard question; Options: rec-offset).
  //
  // CONTENTS
  //   File      New, New from template ▸ (plan 27: Empty, Deep House 122,
  //             Garage 130, Acid 126, Tech House 125; state/templates.ts),
  //             Open… ⌘O, Save ⌘S, Save as… ⇧⌘S, Export WAV…, Undo take
  //   Edit      Undo / Redo, named from the history ("Undo Add note"), ⌘Z / ⇧⌘Z
  //   Add       Drum / Synth / Sampler / Audio track, Transition ▸ (Riser,
  //             Downlifter, Impact: state/transitions.ts), Master row: the
  //             same actions as the playlist footer's buttons (ui/addTrack.ts)
  //   Patterns  New, Duplicate, Rename…, Delete for the selected track's
  //             current pattern (state/pattern-actions.ts, as PatternPicker);
  //             inert with the reason (see below) when the selected track
  //             has no patterns. Convert to steps (synth tracks): snaps a
  //             pattern the Acid tab can't show to steps and opens Acid
  //             (state/acid-actions.ts convertToSteps; inert when Acid shows
  //             it already). Rename… turns the list into a name field
  //             (Enter renames, Esc goes back to the list). The pattern
  //             library (plan 21 Task 4, state/pattern-library.ts): Save to
  //             project library… asks for a name the same way (default
  //             "<track> · <pattern>"); Load from library ▸ opens a submenu
  //             beside it (ui/LibraryList.svelte: load, rename, delete).
  //             → or Enter / Space on it opens the submenu on its first
  //             entry; ← or Esc in the submenu goes back to it (Esc closes
  //             only that layer).
  //   View      Mixer (a toggle), the editor tabs (BottomPanel.pickTab through
  //             `onTab`; a tab the selected track can't show is inert with
  //             shortcuts.ts tabFor's hint, Acid also while the pattern can't
  //             be read as steps: acidUnavailable), Reset lane heights, Performance
  //             (plan 22: a live CPU · dropouts · latency readout, 4 Hz from
  //             TopBar's telemetry; a click opens Audio settings)
  //   Options   Keyboard: octave − / + and "Keys play: <track>"; Note names ▸
  //             (a submenu: Letters / Solfège, aria-pressed); MIDI: <device>
  //             (the MIDI popover; the label is the status: "MIDI: Arturia
  //             KeyStep" / "no device" / "blocked"), Audio settings… (the
  //             modal Settings.svelte), Metronome, Count-in, Recording offset
  //   Help      Keyboard shortcuts… (ShortcutsSheet), About…
  // Plan 22 moved the top bar's pills in here under their test ids:
  // keys-target (the track name in Keys play), octave ("Octave N"; the
  // wheel over its row steps it), note-names (the Note names ▸ item, the
  // old Settings select's id),
  // midi-status (the MIDI item's label), cpu / latency / settings-button
  // (View ▸ Performance). The pills' own octave − / + merged into the menu's
  // (menu-octave-down / -up).
  //
  // SUBMENUS (Patterns ▸ Load from library, Options ▸ Note names, Add ▸ Drum
  // track ▸ one item per built-in kit, menu-add-drum-kit-<id>, Add ▸
  // Transition ▸ Riser / Downlifter / Impact, menu-add-transition-<kind>
  // (plan 28 Task 3), File ▸ New from template ▸ one item per template,
  // menu-template-<id>): one open
  // at a time (`sub`), flying out to the right of their item.
  //   Keys: → or Enter / Space on the item opens it on its first entry;
  //   ↑ ↓ Home End move inside; → inside does nothing. While one is open,
  //   ← and Esc close ONLY it and focus its item, wherever the focus is (in
  //   it, on a sibling item, or on its item after a mouse click).
  //   Pointer (fix round 1): hovering the item opens it after HOVER_OPEN_MS
  //   (150; a click opens it at once, and a click right after a hover-open
  //   never toggles it shut again). Hovering a sibling item, or the pointer
  //   leaving the menu, closes it after HOVER_CLOSE_MS (200), and anything
  //   back inside its item or the submenu cancels that. That delay is the
  //   diagonal GRACE: on the way from the item to an entry the pointer
  //   crosses the items below for a few ms, and the close is only armed, not
  //   run (one timer from the first crossing, not restarted per item). No
  //   "safe triangle": the submenu starts level with its item, so the path
  //   is short. A hover close never fires while a field in the submenu has
  //   the focus (the library's rename), and moves the focus back to the item
  //   if it was inside. One delegated `pointerover` / `pointerleave` on the
  //   popover drives it all (`subHover`); touch pointers are ignored.
  //
  // LOOK (plan 22; revised 2026-11-09): every item is exactly the popover's
  // inner width, so the hover / focus highlight is one full-width band.
  // (Buttons shrink to fit their text even as display: flex, so items inside
  // a wrapper, e.g. the old note-name pair, were narrower: `.it` sets
  // width: 100%.) The popover's own padding is a thin 6 px frame around
  // those bands (8 px at the bottom) and the item's 10 px padding holds the
  // text in, so the text keeps 16 px of room at either side (the owner's
  // plan 22 "more breathing room on the right and bottom") while the
  // highlight reaches nearly to the edge — 16 px of popover padding left
  // the band floating in the middle (the owner: "weird paddings on left and
  // right"). Rows that are not .it (.sec, .info, .oct, .offset, .field,
  // .note, .name) inset by the same 10 px so their text lines up.
  // The card has a 1 px --raised border and a --drop under the --lift: a
  // bare --panel card over the --top bar and the --panel/--work views
  // blended in (the owner: "blends in with the background a lot").
  //
  // THE MENU ROW: 5 px button padding (the words read as separate targets),
  // and TopBar.svelte keeps 4 px under the row and room to its right.
  // Below 1400 px wide it is the old tight row (3 px, no gap; ~38 px
  // narrower) so the bar still fits one row at 1280 px with the "Audio
  // paused" pill or a warning badge in it (audiostart.spec.ts; the pill
  // tightens below 1400 px too).
  //
  // KEYBOARD AND FOCUS. Each menu is a button (aria-expanded, aria-controls)
  // and a popover holding a plain list of buttons: no role=menu (plan 20's
  // rule: no ARIA menu without its full keyboard model; Options also holds a
  // number field and File a question). On top of Tab:
  //   - on a menu button: ↓ opens it on its first item, ↑ on its last;
  //     ← / → go to the neighbouring menu (opening it if one was open);
  //   - inside an open menu: ↑ / ↓ move between the items (wrapping), Home /
  //     End jump to the first / last, ← / → open the neighbouring menu. Keys
  //     typed into a field (the offset, the rename) stay with the field;
  //   - Esc closes the menu and puts the focus back on what opened it (its
  //     button, the project name, or what had the focus before ⌘O);
  //   - a press outside the menu row and `alsoInside` (the project name,
  //     which toggles File) closes it, and so does the focus leaving them;
  //   - while one menu is open, pointing at another menu button opens that
  //     one instead (only one is ever open).
  // Commands close the menu and return the focus to its opener. Settings
  // (octave − / +, Metronome, Count-in, the offset) and Undo take keep it
  // open: they are often used twice in a row.
  // An item that can't run now is INERT, not disabled (ui/inertItem.ts):
  // aria-disabled, still focusable and in the arrow-key list, its reason
  // read out through aria-describedby (and shown as its tooltip).
  // While a menu is open, keys typed in it or on a menu button stay there
  // (keepKey): only Escape and Cmd / Ctrl chords reach the global shortcuts.
  // A closed menu button keeps only its arrow keys.
  //
  // ESC LAYERING (Review focus 2). The Esc listener is on `document`
  // (bubble): it runs after any control inside (an Esc a field used itself,
  // e.g. NumberField reverting a typed offset, is defaultPrevented and leaves
  // the menu open) and before the window's listeners, so its
  // stopPropagation keeps the App's Esc-ends-MIDI-learn (and a drag's
  // window-level Esc cancel) from also acting: one Esc closes only the
  // topmost layer, the menu. The value popover and a press-to-drag can't be open
  // together with a menu: opening either is a press outside the other.
  //
  // NEW / OPEN ask inline in the File menu (no confirm()) when something
  // would be lost (project/discard.ts). New from template ▸ <template> asks
  // the same question, in the same place ("Discard and start new"). ⌘O goes
  // through `request`, which opens the File menu on that question, or runs at
  // once when nothing would be lost (still inside the key press: the folder
  // picker needs a gesture).
  import { tick, untrack } from 'svelte';
  import type { Component } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { Project } from '../state/project.svelte';
  import { MAX_PATTERNS } from '../audio/protocol';
  import { currentPattern, isPatternTrack } from '../state/project.svelte';
  import { LOADING_TEXT, liveInputTrack, setMetronome } from '../state/actions';
  import {
    PATTERNS_FULL_TEXT, deletePattern, duplicatePattern, newPattern, renamePattern,
  } from '../state/pattern-actions';
  import { REC_OFFSET_MAX, REC_OFFSET_MIN, undoTakeTitle } from '../state/recorder';
  import { BT_LATENCY_MS } from '../audio/restart';
  import type { Recorder, RecStatus } from '../state/recorder';
  import { recPrefs, seedRecPrefs, setCountIn, setRecOffset } from '../state/recPrefs.svelte';
  import type { ProjectSession } from '../project/session';
  import { discardWarning } from '../project/discard';
  import { runExport } from '../export/exportFlow';
  import { banners, flashHint } from '../state/banners.svelte';
  import { LIBRARY_NAME_MAX, defaultLibraryName, saveBlocked, savePatternToLibrary } from '../state/pattern-library';
  import { tabFor } from '../input/shortcuts';
  import { acidUnavailable, convertToSteps } from '../state/acid-actions';
  import type { PanelTab } from '../input/shortcuts';
  import { IS_MAC, formatKeys } from '../input/shortcutList';
  import { wheelOctaveSteps } from '../input/qwertyPiano';
  import { MASTER_ITEM, TRACK_ITEMS, addBlocked, addKitTrack, addTrack, addTransitionTrack } from './addTrack';
  import { TRANSITIONS, transitionBlocked } from '../state/transitions';
  import type { TransitionKind } from '../state/transitions';
  import { useAutoBus } from './autoBus';
  import { KITS } from '../state/kits';
  import { TEMPLATE_MENU } from '../state/templates';
  import type { AddItem, AddKind } from './addTrack';
  import { laneView } from './song/laneView.svelte';
  import { noteNames, setNoteNames } from './noteNames.svelte';
  import NumberField from './NumberField.svelte';
  import ShortcutsSheet from './ShortcutsSheet.svelte';
  import Icon from './Icon.svelte';
  import LibraryList from './LibraryList.svelte';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import { blockInert, inertItem } from './inertItem';
  import type { MidiStatus } from '../input/midi';
  import { midiLabel, midiTip } from './topStatus';
  import Gauge from 'phosphor-svelte/lib/Gauge';
  import TextAa from 'phosphor-svelte/lib/TextAa';
  import TrendUp from 'phosphor-svelte/lib/TrendUp';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import ArrowCounterClockwise from 'phosphor-svelte/lib/ArrowCounterClockwise';
  import ArrowsVertical from 'phosphor-svelte/lib/ArrowsVertical';
  import Check from 'phosphor-svelte/lib/Check';
  import Copy from 'phosphor-svelte/lib/Copy';
  import Export from 'phosphor-svelte/lib/Export';
  import Faders from 'phosphor-svelte/lib/Faders';
  import FadersHorizontal from 'phosphor-svelte/lib/FadersHorizontal';
  import FileAudio from 'phosphor-svelte/lib/FileAudio';
  import FilePlus from 'phosphor-svelte/lib/FilePlus';
  import Files from 'phosphor-svelte/lib/Files';
  import FloppyDisk from 'phosphor-svelte/lib/FloppyDisk';
  import FloppyDiskBack from 'phosphor-svelte/lib/FloppyDiskBack';
  import FolderOpen from 'phosphor-svelte/lib/FolderOpen';
  // The pattern library has its own pair (bookmark = keep a copy, books = the
  // library), never the project's floppy / folder.
  import BookmarkSimple from 'phosphor-svelte/lib/BookmarkSimple';
  import Books from 'phosphor-svelte/lib/Books';
  import Gear from 'phosphor-svelte/lib/Gear';
  import GridFour from 'phosphor-svelte/lib/GridFour';
  import Info from 'phosphor-svelte/lib/Info';
  import Keyboard from 'phosphor-svelte/lib/Keyboard';
  import Metronome from 'phosphor-svelte/lib/Metronome';
  import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
  import PianoKeys from 'phosphor-svelte/lib/PianoKeys';
  import Plugs from 'phosphor-svelte/lib/Plugs';
  import Plus from 'phosphor-svelte/lib/Plus';
  import Sliders from 'phosphor-svelte/lib/Sliders';
  import Timer from 'phosphor-svelte/lib/Timer';
  import Trash from 'phosphor-svelte/lib/Trash';
  import WaveSquare from 'phosphor-svelte/lib/WaveSquare';
  import Waveform from 'phosphor-svelte/lib/Waveform';

  let {
    p,
    engine,
    session,
    restoreOffer = null,
    recorder,
    rec,
    undoLabels = { undo: null, redo: null },
    onUndo,
    onRedo,
    octave,
    onOctave,
    onTab = () => {},
    midi = { state: 'no-devices', devices: [] },
    perf = { cpu: 0, dropouts: 0, latencyMs: 0, latencyText: '' },
    onOpenMidi,
    onOpenSettings,
    alsoInside = null,
    open = $bindable(null),
  }: {
    p: Project;
    engine: AudioEngine;
    session: ProjectSession;
    /** The "Restore last session" offer, while it is open (New / Open would discard it). */
    restoreOffer?: { name: string } | null;
    recorder: Recorder;
    rec: RecStatus;
    undoLabels?: { undo: string | null; redo: string | null };
    onUndo: () => void;
    onRedo: () => void;
    octave: number;
    onOctave: (o: number) => void;
    /** View ▸ an editor tab (App: BottomPanel.pickTab). */
    onTab?: (t: PanelTab) => void;
    /** The MIDI status (Options ▸ MIDI…'s label). */
    midi?: MidiStatus;
    /** View ▸ Performance's live readout (TopBar's 4 Hz telemetry). */
    perf?: { cpu: number; dropouts: number; latencyMs: number; latencyText: string };
    /** Options ▸ MIDI…: open the MIDI popover under `back` (the Options button); Esc in it returns the focus there. */
    onOpenMidi: (back: HTMLElement) => void;
    /** Options ▸ Audio settings…, View ▸ Performance: open the Settings dialog; its close returns the focus to `back`. */
    onOpenSettings: (back: HTMLElement | null) => void;
    /** Besides the menu row, presses / focus here are not "outside" (TopBar's name button: it toggles File itself). */
    alsoInside?: HTMLElement | null;
    /** The open menu's name (bindable: TopBar's name button shows File's state). */
    open?: string | null;
  } = $props();

  const MENUS = ['File', 'Edit', 'Add', 'Patterns', 'View', 'Options', 'Help'] as const;
  type MenuName = (typeof MENUS)[number];
  const slug = (m: string) => m.toLowerCase();
  const kbd = (k: string) => formatKeys(k, IS_MAC);
  /** Why an item is inert while a load / New replaces the session. */
  const LOADING = LOADING_TEXT;

  let root = $state<HTMLElement | null>(null);
  /** Every menu's popover stays in the DOM, hidden while closed (as the ⋯ <details> did: tests read a hidden item's state). */
  const panels: Partial<Record<MenuName, HTMLElement>> = $state({});
  /** The open menu's popover. */
  const panel = () => (open ? (panels[open as MenuName] ?? null) : null);
  const btns: Partial<Record<MenuName, HTMLButtonElement>> = $state({});
  /** What gets the focus back when the menu closes (its button, the name, or the focus before ⌘O). */
  let opener: HTMLElement | null = null;

  // ---- open / close --------------------------------------------------------
  // Both clear the submenu hover timers (cancelHover): a pending hover-open or
  // grace-close must not fire into the next menu (or after the menu closed).
  function show(m: MenuName, from: HTMLElement | null = btns[m] ?? null) {
    cancelHover();
    confirming = null;
    template = null;
    renaming = false;
    saving = false;
    sub = null;
    opener = from;
    open = m;
  }
  function close() {
    cancelHover();
    confirming = null;
    template = null;
    renaming = false;
    saving = false;
    sub = null;
    open = null;
  }
  /** Close and give the focus back to the opener (after a command, Escape), never to <body>. */
  function closeToOpener() {
    const m = open as MenuName | null;
    const back = opener?.isConnected ? opener : m ? btns[m] : null;
    close();
    back?.focus();
  }

  /** Menu `m`'s button (TopBar: where a dialog's focus goes when its own opener is gone). */
  export function menuButton(m: MenuName): HTMLButtonElement | null {
    return btns[m] ?? null;
  }

  /** Toggle menu `m` (the name button opens File through this, as the ⋯ once was). */
  export function toggle(m: MenuName, from: HTMLElement) {
    if (open === m) close();
    else show(m, from);
  }

  // While a menu is open, pointing at another menu button opens that one; the
  // click that usually follows (the pointer was on its way to click it) must
  // not toggle it shut again.
  let hoverOpened: MenuName | null = null;
  function hoverSwitch(m: MenuName, el: HTMLElement) {
    if (!open || open === m) return;
    show(m, el);
    hoverOpened = m;
  }
  function buttonClick(m: MenuName, el: HTMLElement) {
    if (hoverOpened === m && open === m) {
      hoverOpened = null;
      return;
    }
    hoverOpened = null;
    toggle(m, el);
  }

  // ---- keyboard ------------------------------------------------------------
  const itemsOf = () =>
    panel() ? [...panel()!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter((el) => el.tabIndex >= 0 && !el.closest('.sub')) : []; // the library submenu has its own (subKey)
  async function focusItem(which: 'first' | 'last') {
    await tick();
    const items = itemsOf();
    (which === 'first' ? items[0] : items[items.length - 1])?.focus();
  }
  const neighbour = (m: MenuName, d: 1 | -1) => MENUS[(MENUS.indexOf(m) + d + MENUS.length) % MENUS.length];

  function buttonKey(e: KeyboardEvent, m: MenuName) {
    // While a menu is open its keys stay with the menu bar (keepKey). On a
    // CLOSED menu button only the keys it handles itself (the arrows) stop
    // here: focus comes back to the button after every command, so Space,
    // the piano keys, R, Z / X and Alt+digit must still reach the global
    // shortcuts (Space never also presses the button: the shortcut prevents it).
    if (open) keepKey(e);
    if (e.key.startsWith('Arrow')) e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open !== m) show(m);
      void focusItem(e.key === 'ArrowDown' ? 'first' : 'last');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const n = neighbour(m, e.key === 'ArrowRight' ? 1 : -1);
      if (open) show(n);
      btns[n]?.focus();
    }
  }
  /**
   * Keys typed inside an open menu (or on a menu button while one is open)
   * stay there: Space presses the focused item (never also starts the song), letters never
   * play notes, arm recording or move the octave (the global shortcuts
   * listen on window). Escape still bubbles to the document listener below
   * (it closes the menu), and Cmd / Ctrl chords (⌘S, ⌘O, ⌘Z) still work.
   */
  function keepKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' && !e.metaKey && !e.ctrlKey) e.stopPropagation();
  }
  /** A text field keeps its keys (arrows move the caret / step the value). */
  const isField = (t: EventTarget | null) => t instanceof HTMLInputElement;
  function panelKey(e: KeyboardEvent) {
    keepKey(e);
    if (!open || isField(e.target)) return;
    if (sub && e.key === 'ArrowLeft') {
      // A submenu open (by the mouse, the focus outside it): ← closes only it.
      e.preventDefault();
      e.stopPropagation();
      closeSub();
      return;
    }
    const items = itemsOf();
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[i <= 0 ? items.length - 1 : i - 1];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      show(neighbour(open as MenuName, e.key === 'ArrowRight' ? 1 : -1));
      void focusItem('first');
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  }

  const inside = (n: Node) => !!root?.contains(n) || !!alsoInside?.contains(n);
  // While open: Escape anywhere closes it (see ESC LAYERING above); a press
  // outside the row (and `alsoInside`) closes it (the focus stays where the press put it). The
  // listeners stay attached and read `open` themselves.
  $effect(() => {
    const outside = (e: PointerEvent) => {
      if (open && !inside(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !open) return;
      e.stopPropagation(); // not also "cancel learn" etc.
      e.preventDefault();
      if (sub) closeSub(); // the topmost layer only (SUBMENUS)
      else closeToOpener();
    };
    window.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
    };
  });
  /** Tab out of the left block closes the menu. A null relatedTarget (window blur, a press on nothing focusable) is the pointer handler's call. */
  function focusOut(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (open && to && !inside(to)) close();
  }

  // ---- File ----------------------------------------------------------------
  /** New/Open waiting for "Discard and …" (only asked when something would be lost). */
  let confirming = $state<'new' | 'open' | null>(null);
  /** The template New from template ▸ would start, while its "Discard and start new" is asked (else null: plain New). */
  let template: string | null = null;
  const warning = $derived(discardWarning(p, restoreOffer));
  function run(cmd: 'new' | 'open' | 'save' | 'saveAs' | 'export') {
    if ((cmd === 'new' || cmd === 'open') && discardWarning(p, restoreOffer) !== null && confirming !== cmd) {
      confirming = cmd;
      sub = null;
      // The focus goes to Cancel (the safe answer), not to "Discard".
      void tick().then(() => panel()?.querySelector<HTMLElement>('[data-testid="project-discard-cancel"]')?.focus());
      return;
    }
    const id = template;
    template = null;
    closeToOpener();
    if (cmd === 'new' && id !== null) void session.newFromTemplate(id);
    else if (cmd === 'new') void session.newProject();
    else if (cmd === 'open') void session.open();
    else if (cmd === 'save') void session.save();
    else if (cmd === 'export') void runExport(p, engine.context);
    else void session.saveAs();
  }
  /** File ▸ New from template ▸ `id`: New with that template (asks first, as New). */
  function newFrom(id: string) {
    template = id; // kept through the "Discard and start new" question (show / close / Cancel drop it)
    run('new');
  }
  /** Cancel on the discard question: back to the list, the focus on its first item. */
  async function cancelDiscard() {
    confirming = null;
    template = null;
    await tick();
    panel()?.querySelector<HTMLElement>('[data-testid="project-new"]')?.focus();
  }
  /**
   * ⌘O / Ctrl+O (App → TopBar.request): the same as the menu item, so it
   * asks the same question — File opens on the "Discard and open…" prompt
   * when something would be lost, else the folder picker opens at once.
   */
  export function request(cmd: 'new' | 'open') {
    template = null; // never a template's question carried over
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : (btns.File ?? null);
    if (discardWarning(p, restoreOffer) !== null) {
      // Ask (again: a second ⌘O re-asks, it never confirms the discard).
      open = 'File';
      renaming = false;
      saving = false;
      sub = null;
      confirming = null;
    }
    run(cmd);
  }

  // ---- Edit ----------------------------------------------------------------
  function edit(fn: () => void) {
    closeToOpener();
    fn();
  }

  // ---- Add -----------------------------------------------------------------
  const ADD_ICONS: Record<AddKind, Component<any>> = {
    // As the playlist's "+ Add track" menu (song/AddTrackMenu.svelte).
    drum: GridFour, synth: PianoKeys, sampler: Waveform, audio: FileAudio, master: FadersHorizontal,
  };
  function add(kind: AddKind) {
    closeToOpener();
    addTrack(p, engine, kind);
  }
  /** Add ▸ Drum track ▸ <kit> (plan 25): a drum track made of that kit. */
  function addKit(kitId: string) {
    closeToOpener();
    void addKitTrack(p, engine, kitId);
  }
  /** Add ▸ Transition ▸ <kind> (plan 28 Task 3): its clip at the song playhead's bar. */
  const bus = useAutoBus();
  function addTransitionItem(kind: TransitionKind) {
    closeToOpener();
    addTransitionTrack(p, engine, kind, bus?.songTick() ?? p.songPosition);
  }

  // ---- Patterns ------------------------------------------------------------
  const selected = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  const ptrack = $derived(selected && isPatternTrack(selected) ? selected : null);
  const cur = $derived(ptrack ? currentPattern(ptrack) : null);
  const NO_PATTERNS = 'Select a drum or synth track';
  const fullWhy = $derived(!ptrack ? NO_PATTERNS : ptrack.patterns.length >= MAX_PATTERNS ? PATTERNS_FULL_TEXT : null);
  /** Convert to steps: only for a synth pattern the Acid tab can't show yet. */
  const convertWhy = $derived(
    selected?.kind !== 'synth' ? 'Select a synth track' : acidUnavailable(selected) ? null : 'The Acid tab already shows this pattern',
  );
  const deleteWhy = $derived.by(() => {
    if (!ptrack || !cur) return NO_PATTERNS;
    if (ptrack.patterns.length <= 1) return 'A track needs at least one pattern';
    const used = ptrack.clips.filter((c) => c.patternId === cur.id).length;
    return used > 0 ? `Used by ${used} clip${used === 1 ? '' : 's'}` : null;
  });
  let renaming = $state(false);
  let draft = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);
  async function startRename() {
    if (!cur) return;
    draft = cur.name;
    sub = null;
    renaming = true;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }
  function renameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (ptrack && cur && renamePattern(p, engine, ptrack.id, cur.id, draft)) closeToOpener();
      // An empty name is rejected: the field stays.
    } else if (e.key === 'Escape') {
      e.preventDefault(); // back to the list, the menu stays open
      renaming = false;
      void tick().then(() => panel()?.querySelector<HTMLElement>('[data-testid="menu-pattern-rename"]')?.focus());
    }
  }
  // The library: Save asks for a name (as Rename); Load is a submenu.
  let saving = $state(false);
  let saveInput = $state<HTMLInputElement | null>(null);
  /** Why Save to project library… can't run (no pattern track, a full library). */
  const saveWhy = $derived(ptrack ? saveBlocked(p) : NO_PATTERNS);
  async function startSave() {
    if (!ptrack || !cur) return;
    draft = defaultLibraryName(ptrack, cur.name);
    sub = null;
    saving = true;
    await tick();
    saveInput?.focus();
    saveInput?.select();
  }
  function saveKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = ptrack && cur ? savePatternToLibrary(p, ptrack.id, cur.id, draft) : null;
      if (!entry) return; // an empty name: the field stays
      closeToOpener();
      flashHint(`Saved “${entry.name}” to the pattern library`);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // back to the list, the menu stays open
      saving = false;
      void tick().then(() => panel()?.querySelector<HTMLElement>('[data-testid="menu-pattern-save"]')?.focus());
    }
  }
  // ---- submenus (SUBMENUS above) --------------------------------------------
  type SubName = 'lib' | 'notes' | 'kits' | 'transitions' | 'templates';
  /** The open submenu (one at a time). */
  let sub = $state<SubName | null>(null);
  const subBtns: Partial<Record<SubName, HTMLButtonElement>> = $state({});
  let subEl = $state<HTMLElement | null>(null);
  const subItems = () => (subEl ? [...subEl.querySelectorAll<HTMLElement>('button, input')] : []);
  async function openSub(s: SubName, focusFirst: boolean) {
    cancelHover();
    sub = s;
    await tick();
    if (focusFirst) (subItems()[0] ?? subEl?.querySelector<HTMLElement>('[tabindex]'))?.focus();
  }
  function closeSub() {
    cancelHover();
    const back = sub ? subBtns[sub] : null;
    sub = null;
    back?.focus();
  }
  /** A click on a submenu's item: toggle it (Enter / Space are clicks with detail 0: open on its first entry). */
  function subClick(s: SubName, e: MouseEvent) {
    if (sub === s && hoverOpenedSub === s) {
      hoverOpenedSub = null; // the click that follows a hover-open: keep it open
      return;
    }
    hoverOpenedSub = null;
    if (sub === s) closeSub();
    else void openSub(s, e.detail === 0);
  }

  // The pointer (SUBMENUS above).
  const HOVER_OPEN_MS = 150;
  const HOVER_CLOSE_MS = 200;
  let openTimer = 0;
  let openFor: SubName | null = null;
  let closeTimer = 0;
  /** The submenu a hover opened, until the pointer leaves its item (its click then keeps it open). */
  let hoverOpenedSub: SubName | null = null;
  function cancelHover() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = 0;
    openFor = null;
  }
  function armClose() {
    if (closeTimer) return; // one grace period from the first crossing (not restarted per item)
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      if (!sub) return;
      const a = document.activeElement;
      if (a instanceof HTMLInputElement && subEl?.contains(a)) return; // typing in it (the library's rename)
      if (subEl?.contains(a)) closeSub();
      else sub = null;
    }, HOVER_CLOSE_MS);
  }
  /** Delegated `pointerover` / `pointerleave` on a popover: open on hovering a submenu's item, close on hovering away. */
  function subHover(e: PointerEvent) {
    if (e.pointerType === 'touch') return;
    const wrap = e.type === 'pointerleave' ? null : (e.target as Element).closest<HTMLElement>('.subwrap[data-sub]');
    const s = (wrap?.dataset.sub as SubName | undefined) ?? null;
    const onItem = !!s && !!subBtns[s]?.contains(e.target as Node);
    if (!onItem) hoverOpenedSub = null;
    if (s && s === sub) {
      // Back in the open submenu or on its item: stay.
      clearTimeout(closeTimer);
      closeTimer = 0;
      return;
    }
    if (s && onItem) {
      // On another submenu's item: open it soon (the open one goes with it).
      clearTimeout(closeTimer);
      closeTimer = 0;
      if (openFor === s) return;
      clearTimeout(openTimer);
      openFor = s;
      openTimer = window.setTimeout(() => {
        openTimer = 0;
        openFor = null;
        if (!open || sub === s) return;
        hoverOpenedSub = s;
        void openSub(s, false);
      }, HOVER_OPEN_MS);
      return;
    }
    // A sibling item, or out of the menu.
    clearTimeout(openTimer);
    openTimer = 0;
    openFor = null;
    if (sub) armClose();
  }
  function subBtnKey(e: KeyboardEvent, s: SubName) {
    hoverOpenedSub = null; // a key press on the item is never "the click after a hover"
    if (e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // not panelKey's "next menu"
    void openSub(s, true);
  }
  /** Keys in a submenu: ↑ ↓ Home End move inside it; ← and Esc go back to its item. */
  function subKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.target instanceof HTMLInputElement) return; // the rename field's own keys
    const items = subItems();
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[i <= 0 ? items.length - 1 : i - 1];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault(); // Esc: the document listener leaves the menu open (topmost layer only)
      e.stopPropagation();
      closeSub();
      return;
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); // nothing further right (never panelKey's "next menu")
      e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  }
  function patternCmd(fn: (trackId: string, patternId: string) => unknown) {
    if (!ptrack || !cur) return;
    const [t, pid] = [ptrack.id, cur.id];
    closeToOpener();
    fn(t, pid);
  }

  // ---- View ----------------------------------------------------------------
  const TABS: { tab: Exclude<PanelTab, 'mixer'>; label: string; keys: string; icon: Component<any> }[] = [
    { tab: 'step', label: 'Step grid', keys: 'Alt+1', icon: GridFour },
    { tab: 'pianoroll', label: 'Piano roll', keys: 'Alt+2', icon: PianoKeys },
    { tab: 'acid', label: 'Acid', keys: 'Alt+3', icon: WaveSquare },
    { tab: 'instrument', label: 'Instrument', keys: 'Alt+4', icon: Sliders },
    { tab: 'clip', label: 'Clip', keys: 'Alt+6', icon: FileAudio },
  ];
  const tabWhy = (t: PanelTab) => {
    const r = tabFor(t, selected?.kind ?? null);
    return 'hint' in r ? r.hint : t === 'acid' ? acidUnavailable(selected) : null;
  };
  function view(fn: () => void) {
    closeToOpener();
    fn();
  }

  // ---- Options -------------------------------------------------------------
  const keysTrack = $derived(liveInputTrack(p));
  // The wheel over the octave row: accumulated (input/qwertyPiano.ts wheelOctaveSteps).
  let wheelAcc = 0;
  function octaveWheel(e: WheelEvent) {
    const r = wheelOctaveSteps(wheelAcc, e.deltaY, e.deltaMode);
    wheelAcc = r.acc;
    if (r.steps) onOctave(Math.min(8, Math.max(0, octave + r.steps)));
  }
  // Count-in and the offset: one reactive mirror shared with the pattern
  // transport (state/recPrefs.svelte.ts).
  seedRecPrefs(untrack(() => recorder));
  $effect(() => seedRecPrefs(recorder));
  function openMidi() {
    const back = btns.Options ?? null;
    closeToOpener();
    if (back) onOpenMidi(back);
  }
  /** Options ▸ Audio settings…, View ▸ Performance: the dialog; its close gives the focus back to menu `m`'s button. */
  function settingsFrom(m: MenuName) {
    const back = btns[m] ?? null;
    closeToOpener();
    onOpenSettings(back);
  }

  // ---- Help ----------------------------------------------------------------
  let sheet = $state<'shortcuts' | 'about' | null>(null);
  function openSheet(kind: 'shortcuts' | 'about') {
    closeToOpener();
    sheet = kind;
  }
</script>

<!-- One Add menu item (the Add menu below): Drum track ▸ its kits, or a plain item. -->
{#snippet addItem(a: AddItem)}
  {@const why = addBlocked(p, a.kind)}
  {#if a.kind === 'drum'}
    <!-- Drum track ▸ a kit (plan 25): Starter (what the playlist's "Drum track" adds) and the others. -->
    <div class="subwrap" data-sub="kits">
      <button
        class="it" data-testid="menu-add-drum" bind:this={subBtns.kits} aria-expanded={sub === 'kits'} aria-controls="menu-add-kits"
        use:inertItem={why ?? (p.loading ? LOADING : null)} title={why ?? 'Add a drum track made of a built-in kit'}
        onclick={(e) => subClick('kits', e)} onkeydown={(e) => subBtnKey(e, 'kits')}
      ><Icon icon={ADD_ICONS.drum} /><span class="l">{a.label}</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
      {#if sub === 'kits'}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="sub" id="menu-add-kits" role="group" aria-label="Drum kits" bind:this={subEl} onkeydown={subKey}>
          {#each KITS as k (k.id)}
            <button class="it" data-testid="menu-add-drum-kit-{k.id}" title={k.blurb} onclick={() => addKit(k.id)}>
              <span class="l">{k.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <button class="it" data-testid={`menu-add-${a.kind}`} use:inertItem={why ?? (p.loading ? LOADING : null)} title={why ?? a.title} onclick={() => add(a.kind)}>
      <Icon icon={ADD_ICONS[a.kind]} /><span class="l">{a.label}</span>
    </button>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menubar" role="group" aria-label="Menu bar" bind:this={root} onfocusout={focusOut}>
  {#each MENUS as m (m)}
    <span class="m">
      <button
        class="mb" class:open={open === m} data-testid={`menu-${slug(m)}`} bind:this={btns[m]}
        aria-expanded={open === m} aria-controls={`menu-${slug(m)}-panel`}
        onclick={(e) => buttonClick(m, e.currentTarget)} onkeydown={(e) => buttonKey(e, m)}
        onpointerenter={(e) => hoverSwitch(m, e.currentTarget)} onpointerleave={() => (hoverOpened = null)}
      >{m}</button>
      <!-- A plain group of buttons (no menu role: see KEYBOARD AND FOCUS). -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="pop" id={`menu-${slug(m)}-panel`} role="group" aria-label={m} data-testid={`menu-${slug(m)}-panel`}
        hidden={open !== m} bind:this={panels[m]} onkeydown={panelKey} onclickcapture={blockInert}
        onpointerover={subHover} onpointerleave={subHover}
      >
        {#if m === 'File'}
          {#if confirming}
            <p class="discard" data-testid="project-discard-warning">{warning}</p>
            <div class="row">
              <button class="btn danger" data-testid="project-discard" onclick={() => run(confirming!)}>
                Discard and {confirming === 'new' ? 'start new' : 'open…'}
              </button>
              <button class="btn" data-testid="project-discard-cancel" onclick={() => void cancelDiscard()}>Cancel</button>
            </div>
          {:else}
            <button class="it" data-testid="project-new" onclick={() => run('new')}><Icon icon={FilePlus} /><span class="l">New</span></button>
            <!-- New from template ▸ (plan 27): Empty (= New) and the templates (state/templates.ts). -->
            <div class="subwrap" data-sub="templates">
              <button
                class="it" data-testid="project-new-template" bind:this={subBtns.templates} aria-expanded={sub === 'templates'} aria-controls="menu-templates"
                use:inertItem={p.loading ? LOADING : null} title="Start a new project from a template: tempo, key, tracks, mix and a 32-bar arrangement"
                onclick={(e) => subClick('templates', e)} onkeydown={(e) => subBtnKey(e, 'templates')}
              ><Icon icon={Files} /><span class="l">New from template</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
              {#if sub === 'templates'}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="sub" id="menu-templates" role="group" aria-label="Templates" bind:this={subEl} onkeydown={subKey}>
                  {#each TEMPLATE_MENU as t (t.id)}
                    <button class="it" data-testid="menu-template-{t.id}" title={t.blurb} onclick={() => newFrom(t.id)}>
                      <span class="l">{t.name}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <button class="it" data-testid="project-open" onclick={() => run('open')}><Icon icon={FolderOpen} /><span class="l">Open…</span><kbd>{kbd('Mod+O')}</kbd></button>
            <button class="it" data-testid="project-save" onclick={() => run('save')}><Icon icon={FloppyDisk} /><span class="l">Save</span><kbd>{kbd('Mod+S')}</kbd></button>
            <button class="it" data-testid="project-save-as" onclick={() => run('saveAs')}><Icon icon={FloppyDiskBack} /><span class="l">Save as…</span><kbd>{kbd('Shift+Mod+S')}</kbd></button>
            <button
              class="it" data-testid="project-export" use:inertItem={banners.exporting !== null ? 'An export is running' : p.loading ? LOADING : null}
              title="Render the song (Song mode, from the start to the last clip + 2 s, metronome off) to a 24-bit WAV"
              onclick={() => run('export')}
            ><Icon icon={Export} /><span class="l">Export WAV…</span></button>
            <hr />
            <button
              class="it" data-testid="undo-take" use:inertItem={rec.canUndoTake ? null : 'No recording pass to undo'}
              title={undoTakeTitle(rec.takeEdits)} onclick={() => recorder.undoLastTake()}
            ><Icon icon={ArrowCounterClockwise} /><span class="l">Undo take</span></button>
          {/if}
        {:else if m === 'Edit'}
          <button
            class="it" data-testid="menu-undo" use:inertItem={p.loading ? LOADING : undoLabels.undo ? null : 'Nothing to undo'}
            title={undoLabels.undo ? '' : 'Nothing to undo'} onclick={() => edit(onUndo)}
          ><Icon icon={ArrowCounterClockwise} /><span class="l">{undoLabels.undo ? `Undo ${undoLabels.undo}` : 'Undo'}</span><kbd>{kbd('Mod+Z')}</kbd></button>
          <button
            class="it" data-testid="menu-redo" use:inertItem={p.loading ? LOADING : undoLabels.redo ? null : 'Nothing to redo'}
            title={undoLabels.redo ? '' : 'Nothing to redo'} onclick={() => edit(onRedo)}
          ><Icon icon={ArrowClockwise} /><span class="l">{undoLabels.redo ? `Redo ${undoLabels.redo}` : 'Redo'}</span><kbd>{kbd('Shift+Mod+Z')}</kbd></button>
        {:else if m === 'Add'}
          <!-- The track kinds, Transition ▸ (plan 28 Task 3), then the Master row (addTrack.ts TRACK_ITEMS / MASTER_ITEM). -->
          {#each TRACK_ITEMS as a (a.kind)}{@render addItem(a)}{/each}
          {@const trackWhy = addBlocked(p, 'synth')}
          <div class="subwrap" data-sub="transitions">
            <button
              class="it" data-testid="menu-add-transition" bind:this={subBtns.transitions} aria-expanded={sub === 'transitions'} aria-controls="menu-add-transitions"
              use:inertItem={trackWhy ?? (p.loading ? LOADING : null)} title={trackWhy ?? 'Add a transition track at the playhead: a riser, a downlifter or an impact'}
              onclick={(e) => subClick('transitions', e)} onkeydown={(e) => subBtnKey(e, 'transitions')}
            ><Icon icon={TrendUp} /><span class="l">Transition</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
            {#if sub === 'transitions'}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="sub" id="menu-add-transitions" role="group" aria-label="Transitions" bind:this={subEl} onkeydown={subKey}>
                {#each TRANSITIONS as tr (tr.kind)}
                  {@const trWhy = transitionBlocked(p, tr.kind)}
                  <button class="it" data-testid="menu-add-transition-{tr.kind}" use:inertItem={trWhy} title={trWhy ?? tr.title} onclick={() => addTransitionItem(tr.kind)}>
                    <span class="l">{tr.label}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          <hr />
          {@render addItem(MASTER_ITEM)}
        {:else if m === 'Patterns'}
          {#if renaming}
            <label class="field" for="menu-pattern-rename-input">Rename “{cur?.name}”</label>
            <input
              id="menu-pattern-rename-input" class="name" bind:this={renameInput} bind:value={draft} maxlength="40"
              data-testid="menu-pattern-rename-input" onkeydown={renameKey}
            />
            <p class="note">Enter to rename, Esc to go back</p>
          {:else if saving}
            <label class="field" for="menu-pattern-save-input">Save “{cur?.name}” to the library as</label>
            <input
              id="menu-pattern-save-input" class="name" bind:this={saveInput} bind:value={draft} maxlength={LIBRARY_NAME_MAX}
              data-testid="menu-pattern-save-input" onkeydown={saveKey}
            />
            <p class="note">Enter to save, Esc to go back</p>
          {:else}
            <p class="sec" title={ptrack ? '' : NO_PATTERNS}>{ptrack && cur ? `${ptrack.name} · ${cur.name}` : 'No pattern track selected'}</p>
            <button class="it" data-testid="menu-pattern-new" use:inertItem={fullWhy} title={fullWhy ?? 'New empty pattern'} onclick={() => patternCmd((t) => newPattern(p, engine, t))}>
              <Icon icon={Plus} /><span class="l">New</span>
            </button>
            <button class="it" data-testid="menu-pattern-dup" use:inertItem={fullWhy} title={fullWhy ?? 'Duplicate this pattern'} onclick={() => patternCmd((t) => duplicatePattern(p, engine, t))}>
              <Icon icon={Copy} /><span class="l">Duplicate</span>
            </button>
            <button class="it" data-testid="menu-pattern-rename" use:inertItem={ptrack ? null : NO_PATTERNS} title={ptrack ? 'Rename this pattern' : NO_PATTERNS} onclick={() => void startRename()}>
              <Icon icon={PencilSimple} /><span class="l">Rename…</span>
            </button>
            <button class="it" data-testid="menu-pattern-delete" use:inertItem={deleteWhy} title={deleteWhy ?? 'Delete this pattern'} onclick={() => patternCmd((t, pid) => deletePattern(p, engine, t, pid))}>
              <Icon icon={Trash} /><span class="l">Delete</span>
            </button>
            <!-- The Acid tab is disabled while the pattern can't be read as steps (BottomPanel ACID AVAILABILITY): this snaps it to steps (one undo entry) and opens Acid. -->
            <button
              class="it" data-testid="menu-pattern-convert" use:inertItem={convertWhy}
              title={convertWhy ?? 'Snap the notes to 1/16 steps (one note per step) so the Acid tab can show them'}
              onclick={() => patternCmd((t) => { convertToSteps(p, engine, t); onTab('acid'); })}
            ><Icon icon={WaveSquare} /><span class="l">Convert to steps</span></button>
            <hr />
            <button class="it" data-testid="menu-pattern-save" use:inertItem={saveWhy} title={saveWhy ?? 'Store a copy of this pattern in the project'} onclick={() => void startSave()}>
              <Icon icon={BookmarkSimple} /><span class="l">Save to project library…</span>
            </button>
            <div class="subwrap" data-sub="lib">
              <button
                class="it" data-testid="menu-pattern-load" bind:this={subBtns.lib} aria-expanded={sub === 'lib'} aria-controls="menu-pattern-library"
                title="Copy a saved pattern into the selected track as a new pattern"
                onclick={(e) => subClick('lib', e)} onkeydown={(e) => subBtnKey(e, 'lib')}
              ><Icon icon={Books} /><span class="l">Load from library</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
              {#if sub === 'lib'}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="sub" id="menu-pattern-library" bind:this={subEl} onkeydown={subKey}>
                  <LibraryList {p} {engine} track={ptrack} testid="menu-library" onloaded={closeToOpener} />
                </div>
              {/if}
            </div>
          {/if}
        {:else if m === 'View'}
          <button class="it" data-testid="menu-view-mixer" aria-pressed={p.mixerOpen} title="All tracks, the returns and the Master" onclick={() => view(() => (p.mixerOpen = !p.mixerOpen))}>
            <Icon icon={Faders} /><span class="l">Mixer</span><kbd>{kbd('Alt+5')}</kbd>{#if p.mixerOpen}<span class="ck"><Icon icon={Check} /></span>{/if}
          </button>
          <hr />
          {#each TABS as t (t.tab)}
            {@const why = tabWhy(t.tab)}
            <button class="it" data-testid={`menu-view-${t.tab}`} use:inertItem={why} title={why ?? ''} onclick={() => view(() => onTab(t.tab))}>
              <Icon icon={t.icon} /><span class="l">{t.label}</span><kbd>{kbd(t.keys)}</kbd>
            </button>
          {/each}
          <hr />
          <button
            class="it" data-testid="menu-view-reset-lanes" use:inertItem={laneView.heights.size ? null : 'No lane was resized'}
            title={laneView.heights.size ? 'Give every automation lane its default height' : 'No lane was resized'}
            onclick={() => view(() => (laneView.heights = new Map()))}
          ><Icon icon={ArrowsVertical} /><span class="l">Reset lane heights</span></button>
          <hr />
          <!-- Live (4 Hz): the test ids of the old CPU and ⚙ latency pills. -->
          <button
            class="it perf" data-testid="settings-button"
            title="Audio thread CPU load · {perf.dropouts} dropouts (missed audio blocks) this session · {perf.latencyText}. Click for audio settings."
            onclick={() => settingsFrom('View')}
          >
            <Icon icon={Gauge} /><span class="l">Performance</span>
            <span class="pv cpu" data-testid="cpu" class:bad={perf.dropouts > 0}>CPU {perf.cpu}% · {perf.dropouts} drop</span>
            <span class="pv lat" data-testid="latency" class:warn={perf.latencyMs > BT_LATENCY_MS}>{Math.round(perf.latencyMs)} ms</span>
          </button>
        {:else if m === 'Options'}
          <p class="sec"><Icon icon={Keyboard} size={12} /> Keyboard</p>
          <!-- The wheel steps the octave (as the old top-bar pill did; Svelte's onwheel is passive, and the menu doesn't scroll). -->
          <div class="oct" role="group" aria-label="Octave" data-testid="menu-octave-row" onwheel={octaveWheel}>
            <span class="l" data-testid="octave">Octave <b data-testid="menu-octave">{octave}</b></span>
            <button class="sq" data-testid="menu-octave-down" aria-label="Octave down" title="Octave down (Z)" use:inertItem={octave <= 0 ? 'Already the lowest octave' : null} onclick={() => onOctave(octave - 1)}>−</button>
            <button class="sq" data-testid="menu-octave-up" aria-label="Octave up" title="Octave up (X)" use:inertItem={octave >= 8 ? 'Already the highest octave' : null} onclick={() => onOctave(octave + 1)}>+</button>
          </div>
          <p class="info" data-testid="menu-keys-target" title="The computer keyboard and MIDI play the selected drum or synth track">
            Keys play: {#if keysTrack}<span class="sw" style:background={keysTrack.color}></span>{/if}<b data-testid="keys-target">{keysTrack?.name ?? '(no track)'}</b>
          </p>
          <!-- `note-names`: the old Settings select's id, on the control that replaced it; `menu-notenames`
               (its row, as before the submenu) on the wrapper. -->
          <div class="subwrap" data-sub="notes" data-testid="menu-notenames">
            <button
              class="it" data-testid="note-names" bind:this={subBtns.notes} aria-expanded={sub === 'notes'} aria-controls="menu-notenames-sub"
              onclick={(e) => subClick('notes', e)} onkeydown={(e) => subBtnKey(e, 'notes')}
            ><Icon icon={TextAa} /><span class="l">Note names</span><span class="cur">{noteNames.style === 'letters' ? 'C D E' : 'Do Re Mi'}</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
            {#if sub === 'notes'}
              <!-- Two pressed-state buttons (the menu is plain buttons, no ARIA menu / radio roles). -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="sub notes" id="menu-notenames-sub" role="group" aria-label="Note names" bind:this={subEl} onkeydown={subKey}>
                <button class="it" aria-pressed={noteNames.style === 'letters'} data-testid="menu-notenames-letters" onclick={() => setNoteNames('letters')}>
                  <span class="l">Letters</span><span class="ex">C D E</span><span class="ck" class:off={noteNames.style !== 'letters'}><Icon icon={Check} /></span>
                </button>
                <button class="it" aria-pressed={noteNames.style === 'solfege'} data-testid="menu-notenames-solfege" onclick={() => setNoteNames('solfege')}>
                  <span class="l">Solfège</span><span class="ex">Do Re Mi</span><span class="ck" class:off={noteNames.style !== 'solfege'}><Icon icon={Check} /></span>
                </button>
              </div>
            {/if}
          </div>
          <hr />
          <button class="it" data-testid="menu-midi" title={midiTip(midi)} onclick={openMidi}>
            <Icon icon={Plugs} /><span class="l" data-testid="midi-status">MIDI: {midiLabel(midi)}</span>
          </button>
          <button class="it" data-testid="menu-audio-settings" onclick={() => settingsFrom('Options')}><Icon icon={Gear} /><span class="l">Audio settings…</span></button>
          <hr />
          <button class="it" data-testid="menu-metronome" aria-pressed={p.metronome} onclick={() => setMetronome(p, engine, !p.metronome)}>
            <Icon icon={Metronome} /><span class="l">Metronome</span>{#if p.metronome}<span class="ck"><Icon icon={Check} /></span>{/if}
          </button>
          <button
            class="it" data-testid="menu-count-in" aria-pressed={recPrefs.countIn}
            title="One bar of metronome before recording starts (when armed)" onclick={() => setCountIn(recorder, !recPrefs.countIn)}
          ><Icon icon={Timer} /><span class="l">Count-in</span>{#if recPrefs.countIn}<span class="ck"><Icon icon={Check} /></span>{/if}</button>
          <div class="offset">
            <span class="l" aria-hidden="true">Recording offset</span>
            <NumberField
              testid="rec-offset" ariaLabel="Recording offset (ms)" unit="ms" min={REC_OFFSET_MIN} max={REC_OFFSET_MAX} step={1}
              value={recPrefs.offsetMs} onchange={(v) => setRecOffset(recorder, v)}
            />
          </div>
          <p class="note">Recorded notes land where you heard the beat. If they still land late, raise the offset (positive = earlier).</p>
        {:else if m === 'Help'}
          <button class="it" data-testid="menu-shortcuts" onclick={() => openSheet('shortcuts')}><Icon icon={Keyboard} /><span class="l">Keyboard shortcuts…</span></button>
          <button class="it" data-testid="menu-about" onclick={() => openSheet('about')}><Icon icon={Info} /><span class="l">About…</span></button>
        {/if}
      </div>
    </span>
  {/each}
</div>
{#if sheet}
  <ShortcutsSheet kind={sheet} returnFocus={btns.Help ?? null} onclose={() => (sheet = null)} />
{/if}

<style>
  /* Tokens only. The row: 12 px text buttons, flat until hovered / open
     (a menu bar, not a toolbar of raised buttons). */
  .menubar { display: flex; align-items: center; gap: 1px; }
  .m { position: relative; display: inline-flex; }
  .mb {
    height: 18px; padding: 0 5px; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--text-2);
    font: 500 var(--fs-ctl)/18px var(--font-ui); cursor: pointer;
  }
  .m:first-child .mb { margin-left: -5px; } /* "File" lines up with the name under it */
  .mb:hover, .mb.open { background: var(--raised); color: var(--text); }
  .mb:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  /* Short windows (the 40 px top bar, TopBar.svelte): a 16 px row. */
  @media (max-height: 739px) { .mb { height: 16px; line-height: 16px; } }

  /* The popover: a --panel card with a --raised edge, the lift and a drop
     (LOOK in the header comment): a 6 px frame, 8 px at the bottom. */
  .pop[hidden] { display: none; }
  .pop {
    position: absolute; top: calc(100% + 4px); left: -5px; z-index: 10; width: max-content; min-width: 210px; max-width: 320px;
    display: flex; flex-direction: column; gap: 1px; padding: 6px 6px 8px; white-space: normal;
    background: var(--panel); border: 1px solid var(--raised); border-radius: var(--r-menu); box-shadow: var(--lift), var(--drop); color: var(--text);
    font: 500 var(--fs-ctl) var(--font-ui);
  }
  /* width 100%: a button shrinks to its text even as display: flex, and the
     highlight must be the popover's full inner width (plan 22). */
  .it {
    display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; min-height: 26px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  .it :global(svg) { flex: none; color: var(--text-2); }
  .it .l { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .it:hover:not([aria-disabled='true']) { background: var(--raised); }
  /* aria-disabled is set by use:inertItem (unseen by the compiler: :global). */
  .pop :global(.it[aria-disabled='true']) { opacity: 0.45; cursor: default; }
  .it:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  .sq:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--raised-shadow); }
  .ck { display: inline-flex; }
  .ck :global(svg) { color: var(--accent); }
  /* The unchecked note-name entry keeps the check's room (both rows line up). */
  .ck.off { visibility: hidden; }
  /* Note names ▸: the current style beside the item; the example after each entry. */
  .cur, .ex { font: 500 var(--fs-lbl) var(--font-ui); color: var(--text-2); }
  .sub.notes { min-width: 180px; }
  .sw { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 2px; }
  /* View ▸ Performance: live values in mono (tabular), a warning in a fill
     (never --rec / --accent text on --panel: ui-theme.md "Rules of use"). */
  .pv { padding: 1px 5px; border-radius: var(--r-xs); background: var(--well); font: 500 var(--fs-lbl) var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); text-align: right; }
  /* A fixed width each (final review #1): the menu is max-content wide, so a chip that grew with its digits
     ("CPU 9%" -> "CPU 10%", "0 drop" -> "123 drop") resized the whole View menu at 4 Hz. Widest:
     "CPU 100% · 999 drop" (19 ch) and "999 ms" (6 ch), in the mono font (1ch = one digit). */
  .pv.cpu { min-width: 19ch; }
  .pv.lat { min-width: 6ch; }
  .pv.bad { background: var(--rec); color: var(--on-color); font-weight: 700; }
  .pv.warn { background: var(--accent); color: var(--on-color); font-weight: 700; }
  kbd { font: 500 var(--fs-lbl) var(--font-mono); color: var(--text-2); }
  hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--line); }
  .sec {
    display: flex; align-items: center; gap: 4px; margin: 2px 10px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
  .oct { display: flex; align-items: center; gap: 4px; padding: 2px 10px; }
  .oct .l { flex: 1; }
  .sq {
    width: 24px; height: 22px; padding: 0; border: 0; border-radius: var(--r-sm); background: var(--raised) var(--gloss);
    box-shadow: var(--raised-shadow); color: var(--text); font: 600 var(--fs-ctl) var(--font-ui); cursor: pointer;
  }
  .pop :global(.sq[aria-disabled='true']) { opacity: 0.4; background: var(--raised); box-shadow: none; cursor: default; }
  .info { margin: 2px 10px 2px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .info b { color: var(--text); font-weight: 600; }
  .offset { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 10px; }
  .offset .l { color: var(--text); white-space: nowrap; }
  .note { margin: 2px 10px 4px; font-size: 11px; color: var(--text-2); }
  .discard { margin: 2px 2px 6px; color: var(--accent); }
  .row { display: flex; gap: 6px; }
  .btn.danger { background-color: var(--rec); color: var(--on-color); }
  .field { margin: 2px 10px 4px; color: var(--text-2); }
  .name {
    margin: 0 10px; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow);
    color: var(--text); font: inherit;
  }
  .name:focus-visible { outline: none; box-shadow: var(--focus-ring), var(--well-shadow); }
  /* Load from library ▸: the submenu flies out to the right of its item. */
  .subwrap { position: relative; display: flex; flex-direction: column; }
  .chev { display: inline-flex; }
  .sub {
    position: absolute; left: calc(100% + 7px); top: -7px; z-index: 11; width: max-content; min-width: 240px; max-width: 320px;
    max-height: min(360px, 60vh); overflow-y: auto; padding: 6px 6px 8px;
    background: var(--panel); border: 1px solid var(--raised); border-radius: var(--r-menu); box-shadow: var(--lift), var(--drop);
  }
  /* Narrow windows: the tight row (THE MENU ROW in the header comment);
     last, so it wins over the rules above. */
  @media (max-width: 1399px) {
    .menubar { gap: 0; }
    .mb { padding: 0 3px; }
    .m:first-child .mb { margin-left: -3px; }
    .pop { left: -3px; }
  }
</style>
