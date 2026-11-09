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
  //   File      New, Open… ⌘O, Save ⌘S, Save as… ⇧⌘S, Export WAV…, Undo take
  //   Edit      Undo / Redo, named from the history ("Undo Add note"), ⌘Z / ⇧⌘Z
  //   Add       Drum / Synth / Sampler / Audio track, Master row: the same
  //             actions as the playlist footer's buttons (ui/addTrack.ts)
  //   Patterns  New, Duplicate, Rename…, Delete for the selected track's
  //             current pattern (state/pattern-actions.ts, as PatternPicker);
  //             inert with the reason (see below) when the selected track
  //             has no patterns. Rename… turns the list into a name field
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
  //             shortcuts.ts tabFor's hint), Reset lane heights
  //   Options   Keyboard: octave − / + and "Keys play: <track>"; MIDI… (the
  //             MIDI popover), Audio settings… (the ⚙ Settings panel),
  //             Metronome, Count-in, Recording offset
  //   Help      Keyboard shortcuts… (ShortcutsSheet), About…
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
  // topmost layer, the menu. The AutoMenu and a press-to-drag can't be open
  // together with a menu: opening either is a press outside the other.
  //
  // NEW / OPEN ask inline in the File menu (no confirm()) when something
  // would be lost (project/discard.ts). ⌘O goes through `request`, which
  // opens the File menu on that question, or runs at once when nothing would
  // be lost (still inside the key press: the folder picker needs a gesture).
  import { tick, untrack } from 'svelte';
  import type { Component } from 'svelte';
  import type { AudioEngine } from '../audio/engine';
  import type { Project } from '../state/project.svelte';
  import { MAX_PATTERNS } from '../audio/protocol';
  import { currentPattern, isPatternTrack } from '../state/project.svelte';
  import { liveInputTrack, setMetronome } from '../state/actions';
  import {
    PATTERNS_FULL_TEXT, deletePattern, duplicatePattern, newPattern, renamePattern,
  } from '../state/pattern-actions';
  import { REC_OFFSET_MAX, REC_OFFSET_MIN, undoTakeTitle } from '../state/recorder';
  import type { Recorder, RecStatus } from '../state/recorder';
  import { recPrefs, seedRecPrefs, setCountIn, setRecOffset } from '../state/recPrefs.svelte';
  import type { ProjectSession } from '../project/session';
  import { discardWarning } from '../project/discard';
  import { runExport } from '../export/exportFlow';
  import { banners, flashHint } from '../state/banners.svelte';
  import { LIBRARY_NAME_MAX, defaultLibraryName, saveBlocked, savePatternToLibrary } from '../state/pattern-library';
  import { tabFor } from '../input/shortcuts';
  import type { PanelTab } from '../input/shortcuts';
  import { IS_MAC, formatKeys } from '../input/shortcutList';
  import { ADD_ITEMS, addBlocked, addTrack } from './addTrack';
  import type { AddKind } from './addTrack';
  import { laneView } from './song/laneView.svelte';
  import { noteNames, setNoteNames } from './noteNames.svelte';
  import NumberField from './NumberField.svelte';
  import ShortcutsSheet from './ShortcutsSheet.svelte';
  import Icon from './Icon.svelte';
  import LibraryList from './LibraryList.svelte';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import { blockInert, inertItem } from './inertItem';
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
  import FloppyDisk from 'phosphor-svelte/lib/FloppyDisk';
  import FloppyDiskBack from 'phosphor-svelte/lib/FloppyDiskBack';
  import FolderOpen from 'phosphor-svelte/lib/FolderOpen';
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
    /** Options ▸ MIDI…: open the MIDI popover; Esc in it returns the focus to `back`. */
    onOpenMidi: (back: HTMLElement) => void;
    /** Options ▸ Audio settings…: open the Settings panel. */
    onOpenSettings: () => void;
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
  const LOADING = 'Loading a project…';

  let root = $state<HTMLElement | null>(null);
  /** Every menu's popover stays in the DOM, hidden while closed (as the ⋯ <details> did: tests read a hidden item's state). */
  const panels: Partial<Record<MenuName, HTMLElement>> = {};
  /** The open menu's popover. */
  const panel = () => (open ? (panels[open as MenuName] ?? null) : null);
  const btns: Partial<Record<MenuName, HTMLButtonElement>> = {};
  /** What gets the focus back when the menu closes (its button, the name, or the focus before ⌘O). */
  let opener: HTMLElement | null = null;

  // ---- open / close --------------------------------------------------------
  function show(m: MenuName, from: HTMLElement | null = btns[m] ?? null) {
    confirming = null;
    renaming = false;
    saving = false;
    libOpen = false;
    opener = from;
    open = m;
  }
  function close() {
    confirming = null;
    renaming = false;
    saving = false;
    libOpen = false;
    open = null;
  }
  /** Close and give the focus back to the opener (after a command, Escape), never to <body>. */
  function closeToOpener() {
    const m = open as MenuName | null;
    const back = opener?.isConnected ? opener : m ? btns[m] : null;
    close();
    back?.focus();
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
      closeToOpener();
    };
    window.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key);
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
  const warning = $derived(discardWarning(p, restoreOffer));
  function run(cmd: 'new' | 'open' | 'save' | 'saveAs' | 'export') {
    if ((cmd === 'new' || cmd === 'open') && discardWarning(p, restoreOffer) !== null && confirming !== cmd) {
      confirming = cmd;
      // The focus goes to Cancel (the safe answer), not to "Discard".
      void tick().then(() => panel()?.querySelector<HTMLElement>('[data-testid="project-discard-cancel"]')?.focus());
      return;
    }
    closeToOpener();
    if (cmd === 'new') void session.newProject();
    else if (cmd === 'open') void session.open();
    else if (cmd === 'save') void session.save();
    else if (cmd === 'export') void runExport(p, engine.context);
    else void session.saveAs();
  }
  /** Cancel on the discard question: back to the list, the focus on its first item. */
  async function cancelDiscard() {
    confirming = null;
    await tick();
    panel()?.querySelector<HTMLElement>('[data-testid="project-new"]')?.focus();
  }
  /**
   * ⌘O / Ctrl+O (App → TopBar.request): the same as the menu item, so it
   * asks the same question — File opens on the "Discard and open…" prompt
   * when something would be lost, else the folder picker opens at once.
   */
  export function request(cmd: 'new' | 'open') {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : (btns.File ?? null);
    if (discardWarning(p, restoreOffer) !== null) {
      // Ask (again: a second ⌘O re-asks, it never confirms the discard).
      open = 'File';
      renaming = false;
      saving = false;
      libOpen = false;
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

  // ---- Patterns ------------------------------------------------------------
  const selected = $derived(p.tracks.find((t) => t.id === p.selectedTrackId) ?? null);
  const ptrack = $derived(selected && isPatternTrack(selected) ? selected : null);
  const cur = $derived(ptrack ? currentPattern(ptrack) : null);
  const NO_PATTERNS = 'Select a drum or synth track';
  const fullWhy = $derived(!ptrack ? NO_PATTERNS : ptrack.patterns.length >= MAX_PATTERNS ? PATTERNS_FULL_TEXT : null);
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
  let libOpen = $state(false);
  let libBtn = $state<HTMLButtonElement | null>(null);
  let libSub = $state<HTMLElement | null>(null);
  async function startSave() {
    if (!ptrack || !cur) return;
    draft = defaultLibraryName(ptrack, cur.name);
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
  const subItems = () => (libSub ? [...libSub.querySelectorAll<HTMLElement>('button, input')] : []);
  async function openLib(focusFirst: boolean) {
    libOpen = true;
    await tick();
    if (focusFirst) (subItems()[0] ?? libSub?.querySelector<HTMLElement>('[tabindex]'))?.focus();
  }
  function closeLib() {
    libOpen = false;
    libBtn?.focus();
  }
  function libBtnKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // not panelKey's "next menu"
    void openLib(true);
  }
  /** Keys in the submenu: ↑ ↓ Home End move inside it; ← and Esc go back to Load from library. */
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
      closeLib();
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
    return 'hint' in r ? r.hint : null;
  };
  function view(fn: () => void) {
    closeToOpener();
    fn();
  }

  // ---- Options -------------------------------------------------------------
  const keysTrack = $derived(liveInputTrack(p));
  // Count-in and the offset: one reactive mirror shared with the pattern
  // transport (state/recPrefs.svelte.ts).
  seedRecPrefs(untrack(() => recorder));
  $effect(() => seedRecPrefs(recorder));
  function openMidi() {
    const back = btns.Options ?? null;
    closeToOpener();
    if (back) onOpenMidi(back);
  }
  function openSettings() {
    closeToOpener();
    onOpenSettings();
  }

  // ---- Help ----------------------------------------------------------------
  let sheet = $state<'shortcuts' | 'about' | null>(null);
  function openSheet(kind: 'shortcuts' | 'about') {
    closeToOpener();
    sheet = kind;
  }
</script>

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
            title={undoLabels.undo ? undefined : 'Nothing to undo'} onclick={() => edit(onUndo)}
          ><Icon icon={ArrowCounterClockwise} /><span class="l">{undoLabels.undo ? `Undo ${undoLabels.undo}` : 'Undo'}</span><kbd>{kbd('Mod+Z')}</kbd></button>
          <button
            class="it" data-testid="menu-redo" use:inertItem={p.loading ? LOADING : undoLabels.redo ? null : 'Nothing to redo'}
            title={undoLabels.redo ? undefined : 'Nothing to redo'} onclick={() => edit(onRedo)}
          ><Icon icon={ArrowClockwise} /><span class="l">{undoLabels.redo ? `Redo ${undoLabels.redo}` : 'Redo'}</span><kbd>{kbd('Shift+Mod+Z')}</kbd></button>
        {:else if m === 'Add'}
          {#each ADD_ITEMS as a (a.kind)}
            {@const why = addBlocked(p, a.kind)}
            {#if a.kind === 'master'}<hr />{/if}
            <button class="it" data-testid={`menu-add-${a.kind}`} use:inertItem={why ?? (p.loading ? LOADING : null)} title={why ?? a.title} onclick={() => add(a.kind)}>
              <Icon icon={ADD_ICONS[a.kind]} /><span class="l">{a.label}</span>
            </button>
          {/each}
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
            <p class="sec" title={ptrack ? undefined : NO_PATTERNS}>{ptrack && cur ? `${ptrack.name} · ${cur.name}` : 'No pattern track selected'}</p>
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
            <hr />
            <button class="it" data-testid="menu-pattern-save" use:inertItem={saveWhy} title={saveWhy ?? 'Store a copy of this pattern in the project'} onclick={() => void startSave()}>
              <Icon icon={FloppyDisk} /><span class="l">Save to project library…</span>
            </button>
            <div class="subwrap">
              <button
                class="it" data-testid="menu-pattern-load" bind:this={libBtn} aria-expanded={libOpen} aria-controls="menu-pattern-library"
                title="Copy a saved pattern into the selected track as a new pattern"
                onclick={(e) => (libOpen ? closeLib() : void openLib(e.detail === 0))} onkeydown={libBtnKey}
              ><Icon icon={FolderOpen} /><span class="l">Load from library</span><span class="chev"><Icon icon={CaretRight} size={12} /></span></button>
              {#if libOpen}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="sub" id="menu-pattern-library" bind:this={libSub} onkeydown={subKey}>
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
            <button class="it" data-testid={`menu-view-${t.tab}`} use:inertItem={why} title={why ?? undefined} onclick={() => view(() => onTab(t.tab))}>
              <Icon icon={t.icon} /><span class="l">{t.label}</span><kbd>{kbd(t.keys)}</kbd>
            </button>
          {/each}
          <hr />
          <button
            class="it" data-testid="menu-view-reset-lanes" use:inertItem={laneView.heights.size ? null : 'No lane was resized'}
            title={laneView.heights.size ? 'Give every automation lane its default height' : 'No lane was resized'}
            onclick={() => view(() => (laneView.heights = new Map()))}
          ><Icon icon={ArrowsVertical} /><span class="l">Reset lane heights</span></button>
        {:else if m === 'Options'}
          <p class="sec"><Icon icon={Keyboard} size={12} /> Keyboard</p>
          <div class="oct" role="group" aria-label="Octave">
            <span class="l">Octave <b data-testid="menu-octave">{octave}</b></span>
            <button class="sq" data-testid="menu-octave-down" aria-label="Octave down" title="Octave down (Z)" use:inertItem={octave <= 0 ? 'Already the lowest octave' : null} onclick={() => onOctave(octave - 1)}>−</button>
            <button class="sq" data-testid="menu-octave-up" aria-label="Octave up" title="Octave up (X)" use:inertItem={octave >= 8 ? 'Already the highest octave' : null} onclick={() => onOctave(octave + 1)}>+</button>
          </div>
          <p class="info" data-testid="menu-keys-target" title="The computer keyboard and MIDI play the selected drum or synth track">
            Keys play: <b>{keysTrack?.name ?? '(no track)'}</b>
          </p>
          <div role="radiogroup" aria-label="Note names">
            <button class="it" role="radio" aria-checked={noteNames.style === 'letters'} data-testid="menu-notenames-letters" title="C D E" onclick={() => setNoteNames('letters')}><span class="l">Note names: C D E</span>{#if noteNames.style === 'letters'}<span class="ck"><Icon icon={Check} /></span>{/if}</button>
            <button class="it" role="radio" aria-checked={noteNames.style === 'solfege'} data-testid="menu-notenames-solfege" title="Do Re Mi" onclick={() => setNoteNames('solfege')}><span class="l">Note names: Do Re Mi</span>{#if noteNames.style === 'solfege'}<span class="ck"><Icon icon={Check} /></span>{/if}</button>
          </div>
          <hr />
          <button class="it" data-testid="menu-midi" onclick={openMidi}><Icon icon={Plugs} /><span class="l">MIDI…</span></button>
          <button class="it" data-testid="menu-audio-settings" onclick={openSettings}><Icon icon={Gear} /><span class="l">Audio settings…</span></button>
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
  .menubar { display: flex; align-items: center; gap: 0; }
  .m { position: relative; display: inline-flex; }
  .mb {
    height: 18px; padding: 0 3px; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--text-2);
    font: 500 var(--fs-ctl)/18px var(--font-ui); cursor: pointer;
  }
  .m:first-child .mb { margin-left: -3px; } /* "File" lines up with the name under it */
  .mb:hover, .mb.open { background: var(--raised); color: var(--text); }
  .mb:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  /* Short windows (the 40 px top bar, TopBar.svelte): a 16 px row. */
  @media (max-height: 739px) { .mb { height: 16px; line-height: 16px; } }

  /* The popover: a --panel card with the lift (as plan 20's ⋯ menu). */
  .pop[hidden] { display: none; }
  .pop {
    position: absolute; top: calc(100% + 4px); left: -3px; z-index: 10; width: max-content; min-width: 210px; max-width: 300px;
    display: flex; flex-direction: column; gap: 1px; padding: 6px; white-space: normal;
    background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift); color: var(--text);
    font: 500 var(--fs-ctl) var(--font-ui);
  }
  .it {
    display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 0 8px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer;
  }
  .it :global(svg) { flex: none; color: var(--text-2); }
  .it .l { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .it:hover:not([aria-disabled='true']) { background: var(--raised); }
  /* aria-disabled is set by use:inertItem (unseen by the compiler: :global). */
  .pop :global(.it[aria-disabled='true']) { opacity: 0.45; cursor: default; }
  .it:focus-visible, .sq:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .ck { display: inline-flex; }
  .ck :global(svg) { color: var(--accent); }
  kbd { font: 500 var(--fs-lbl) var(--font-mono); color: var(--text-2); }
  hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--line); }
  .sec {
    display: flex; align-items: center; gap: 4px; margin: 2px 8px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 600 var(--fs-lbl) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
  .oct { display: flex; align-items: center; gap: 4px; padding: 2px 8px; }
  .oct .l { flex: 1; }
  .sq {
    width: 24px; height: 22px; padding: 0; border: 0; border-radius: var(--r-sm); background: var(--raised) var(--gloss);
    box-shadow: var(--raised-shadow); color: var(--text); font: 600 var(--fs-ctl) var(--font-ui); cursor: pointer;
  }
  .pop :global(.sq[aria-disabled='true']) { opacity: 0.4; background: var(--raised); box-shadow: none; cursor: default; }
  .info { margin: 2px 8px 2px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .info b { color: var(--text); font-weight: 600; }
  .offset { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; }
  .offset .l { color: var(--text); white-space: nowrap; }
  .note { margin: 2px 8px 4px; font-size: 11px; color: var(--text-2); }
  .discard { margin: 2px 2px 6px; color: var(--accent); }
  .row { display: flex; gap: 6px; }
  .btn.danger { background-color: var(--rec); color: var(--on-color); }
  .field { margin: 2px 8px 4px; color: var(--text-2); }
  .name {
    margin: 0 8px; padding: 4px 8px; border: 0; border-radius: var(--r-sm); background: var(--well); box-shadow: var(--well-shadow);
    color: var(--text); font: inherit;
  }
  .name:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  /* Load from library ▸: the submenu flies out to the right of its item. */
  .subwrap { position: relative; display: flex; flex-direction: column; }
  .chev { display: inline-flex; }
  .sub {
    position: absolute; left: calc(100% + 6px); top: -6px; z-index: 11; width: max-content; min-width: 240px; max-width: 320px;
    max-height: min(360px, 60vh); overflow-y: auto; padding: 6px;
    background: var(--panel); border-radius: var(--r-md); box-shadow: var(--lift);
  }
</style>
