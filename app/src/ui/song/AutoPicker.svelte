<script lang="ts">
  // "Automate…" (plan 21 §9): the button on an owner's last lane row that
  // adds an automation lane. It replaced the "+ Lane" <select> and keeps its
  // test id (`auto-add-<owner>`: the track's slot, or "m" for the Master row).
  // Tests pick through tests/e2e/automate.ts pickAutomation(page, owner,
  // 'Filter', 'Cutoff').
  //
  // The popover: a search field (`auto-search`, focused on open) over a
  // two-level list, autoPick.ts's groups (a track: Mixer › Volume / Pan /
  // Sends / EQ / Comp, then each rack module by its title in rack order; the
  // Master row: Master / Reverb / Delay). Groups start collapsed; a header
  // click toggles one. A param that already has a lane is listed but
  // disabled ("already automated"). The list scrolls inside a max height, so
  // a rack of 30+ modules stays usable; the popover is position: fixed (the
  // song pane's overflow never clips it), under the button or above it when
  // there is more room there.
  //
  // SEARCH: typing filters across groups (autoPick filterGroups: group or
  // param name, case-insensitive), expands every group left, and makes the
  // best match active (bestMatch: "cut" → Filter › Cutoff, not EQ › Low cut).
  //
  // KEYBOARD (the focus stays in the field; the active row is its
  // aria-activedescendant, a combobox over a flat tree with aria-level):
  //   Up / Down    previous / next visible row (headers and the params of
  //                expanded groups; used params are skipped)
  //   Right        expand a header; on an expanded one, go to its first param
  //   Left         collapse the group (from a param: back to its header)
  //   Enter        pick the active param, or toggle the active header
  //   Esc          close and give the focus back to the button (stopped:
  //                only this layer closes)
  //   Tab          close (the focus moves on)
  // Left / Right drive the list, not the caret: the field holds one word,
  // and Backspace still edits it. A press outside, a resize, or the button
  // moving (the timeline scrolled under the popover) closes it.
  //
  // PICKING adds the lane through automation-actions addLane (one undo
  // entry), exactly as the select did. The button then sits on the new last
  // row (this instance goes), so the focus is let go: the piano keys work.
  import ChartLineUp from 'phosphor-svelte/lib/ChartLineUp';
  import CaretRight from 'phosphor-svelte/lib/CaretRight';
  import Icon from '../Icon.svelte';
  import type { CommandSink } from '../../state/actions';
  import type { Project } from '../../state/project.svelte';
  import { addLane } from '../../state/automation-actions';
  import { bestMatch, filterGroups, pickerRows, rowGroups } from './autoPick';
  import type { PickItem, PickRow } from './autoPick';

  let { p, engine, rowId, testKey, disabled = false, title }: {
    p: Project;
    engine: CommandSink;
    /** The timeline row's owner: a track id, or MASTER_ROW. */
    rowId: string;
    /** The owner's test id key: the track's slot, or "m". */
    testKey: string;
    disabled?: boolean;
    title: string;
  } = $props();

  /** Popover height cap (px): the list scrolls inside it. */
  const MAX_H = 360;
  /** Below this much room under the button the popover opens above it (when there is more room there). */
  const MIN_BELOW = 220;

  let open = $state(false);
  let query = $state('');
  let expanded = $state(new Set<string>());
  /** The active row's key (rowKey), not its index: rows come and go as groups open. */
  let activeKey = $state<string | null>(null);
  let btn = $state<HTMLButtonElement | null>(null);
  let pop = $state<HTMLDivElement | null>(null);
  let field = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  /** Fixed placement (viewport px). */
  let at = $state<{ left: number; top: number | null; bottom: number | null; maxH: number }>({ left: 0, top: 0, bottom: null, maxH: MAX_H });

  const groups = $derived(open ? filterGroups(rowGroups(p, rowId), query) : []);
  const rows = $derived(pickerRows(groups, expanded));
  const rowKey = (r: PickRow) => (r.kind === 'group' ? `g:${r.group.key}` : `i:${r.group.key}:${r.item.target.param}`);
  const activeIndex = $derived(rows.findIndex((r) => rowKey(r) === activeKey));
  /** DOM id of a row (aria-activedescendant): unique per picker. */
  const uid = `ap-${Math.random().toString(36).slice(2, 8)}`;
  const rowDomId = (i: number) => `${uid}-${i}`;
  const selectable = (r: PickRow | undefined) => !!r && (r.kind === 'group' || !r.item.used);

  /** Where the button was when the popover was placed (viewport px). */
  let anchor = { x: 0, y: 0 };
  function place() {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    anchor = { x: r.left, y: r.top };
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const left = Math.max(4, Math.min(r.left, window.innerWidth - 264));
    at = below >= MIN_BELOW || below >= above
      ? { left, top: r.bottom + 4, bottom: null, maxH: Math.min(MAX_H, below) }
      : { left, top: null, bottom: window.innerHeight - r.top + 4, maxH: Math.min(MAX_H, above) };
  }
  function show() {
    place();
    query = '';
    expanded = new Set();
    activeKey = null;
    open = true;
    queueMicrotask(() => {
      field?.focus({ preventScroll: true }); // the timeline must not scroll under the popover (that closes it)
      activeKey = rows[0] ? rowKey(rows[0]) : null;
    });
  }
  function close(refocus: boolean) {
    open = false;
    if (refocus) btn?.focus();
  }
  function pick(it: PickItem) {
    if (it.used) return;
    close(false);
    btn?.blur(); // the button moves to the new last row: give the keys back to the piano
    addLane(p, engine, it.owner, it.target);
  }
  function toggle(key: string, on = !expanded.has(key)) {
    const next = new Set(expanded);
    if (on) next.add(key);
    else next.delete(key);
    expanded = next;
  }

  function search() {
    // Typing opens every group that is left, and the best match becomes active.
    const gs = filterGroups(rowGroups(p, rowId), query);
    expanded = query.trim() ? new Set(gs.map((g) => g.key)) : new Set();
    const rs = pickerRows(gs, expanded);
    const i = bestMatch(rs, query);
    activeKey = i >= 0 ? rowKey(rs[i]) : null;
  }

  /** Move the active row by `dir` over selectable rows (no wrap past the ends). */
  function step(dir: 1 | -1) {
    let i = activeIndex;
    for (let k = i + dir; k >= 0 && k < rows.length; k += dir) {
      if (selectable(rows[k])) {
        i = k;
        break;
      }
    }
    if (i < 0) i = rows.findIndex(selectable);
    if (rows[i]) activeKey = rowKey(rows[i]);
  }

  function key(e: KeyboardEvent) {
    const r = rows[activeIndex];
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      take();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      take();
      step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowRight' && r) {
      take();
      if (r.kind === 'group' && !expanded.has(r.group.key)) toggle(r.group.key, true);
      else if (r.kind === 'group') {
        const first = r.group.items.find((x) => !x.used);
        if (first) activeKey = rowKey({ kind: 'item', group: r.group, item: first });
      }
    } else if (e.key === 'ArrowLeft' && r) {
      take();
      toggle(r.group.key, false);
      activeKey = rowKey({ kind: 'group', group: r.group });
    } else if (e.key === 'Enter') {
      take();
      if (r?.kind === 'item') pick(r.item);
      else if (r) toggle(r.group.key);
    } else if (e.key === 'Tab') close(false);
  }

  // The active row stays in view as the keys move it. By hand, not
  // scrollIntoView: that would scroll the timeline (a DOM ancestor of this
  // fixed popover) too, and a scroll outside closes the popover.
  $effect(() => {
    if (!open || activeIndex < 0 || !list) return;
    const row = list.querySelector<HTMLElement>(`#${rowDomId(activeIndex)}`);
    if (!row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  });

  // A press outside or a resize closes it; so does a scroll that moved the
  // button (the popover would float away from it). A scroll event is
  // dispatched a frame late, so one from just before the click (scrolling
  // the button into view) must not close it: the button's position decides.
  $effect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!btn?.contains(t) && !pop?.contains(t)) close(false);
    };
    const scrolled = (e: Event) => {
      if (pop?.contains(e.target as Node) || !btn) return;
      const r = btn.getBoundingClientRect();
      if (Math.abs(r.left - anchor.x) > 1 || Math.abs(r.top - anchor.y) > 1) close(false);
    };
    const resize = () => close(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resize);
    };
  });
</script>

<button
  bind:this={btn}
  type="button"
  class="auto"
  data-testid="auto-add-{testKey}"
  aria-haspopup="dialog"
  aria-expanded={open}
  {title}
  {disabled}
  onclick={() => (open ? close(false) : show())}
><Icon icon={ChartLineUp} size={12} />Automate…</button>

{#if open}
  <div
    bind:this={pop}
    class="pop"
    role="dialog"
    aria-label="Add an automation lane"
    data-testid="auto-picker"
    style:left="{at.left}px"
    style:top={at.top === null ? null : `${at.top}px`}
    style:bottom={at.bottom === null ? null : `${at.bottom}px`}
    style:max-height="{at.maxH}px"
  >
    <input
      bind:this={field}
      bind:value={query}
      type="search"
      role="combobox"
      aria-expanded="true"
      aria-controls="{uid}-tree"
      aria-activedescendant={activeIndex >= 0 ? rowDomId(activeIndex) : undefined}
      aria-autocomplete="list"
      aria-label="Search parameters"
      placeholder="Search parameters"
      data-testid="auto-search"
      autocomplete="off"
      spellcheck="false"
      oninput={search}
      onkeydown={key}
    />
    <div class="list" bind:this={list} id="{uid}-tree" role="tree" aria-label="Parameters">
      {#each rows as r, i (rowKey(r))}
        {#if r.kind === 'group'}
          {@const isOpen = expanded.has(r.group.key)}
          {@const first = i === 0 || rows[i - 1].group.section !== r.group.section}
          {#if first && r.group.section}<div class="section" aria-hidden="true">{r.group.section}</div>{/if}
          <!-- Rows take no focus (the field keeps it); mousedown must not steal it. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id={rowDomId(i)}
            class="row group"
            class:active={i === activeIndex}
            role="treeitem"
            aria-level="1"
            aria-expanded={isOpen}
            aria-selected={i === activeIndex}
            tabindex="-1"
            data-testid="auto-pick-group"
            data-name={r.group.name}
            onmousedown={(e) => e.preventDefault()}
            onpointermove={() => (activeKey = rowKey(r))}
            onclick={() => {
              activeKey = rowKey(r);
              toggle(r.group.key);
            }}
          >
            <span class="caret" class:open={isOpen}><Icon icon={CaretRight} size={10} /></span>
            <span class="name">{r.group.name}</span>
            <span class="count">{r.group.items.length}</span>
          </div>
        {:else}
          {@const it = r.item}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id={rowDomId(i)}
            class="row item"
            class:active={i === activeIndex}
            class:used={it.used}
            role="treeitem"
            aria-level="2"
            aria-selected={i === activeIndex}
            aria-disabled={it.used}
            tabindex="-1"
            data-testid="auto-pick-item"
            data-group={r.group.name}
            data-name={it.label}
            title={it.used ? `${it.lane}: already automated` : `Add a lane: ${it.lane}`}
            onmousedown={(e) => e.preventDefault()}
            onpointermove={() => !it.used && (activeKey = rowKey(r))}
            onclick={() => pick(it)}
          >
            <span class="name">{it.label}</span>
            {#if it.used}<span class="note">already automated</span>{/if}
          </div>
        {/if}
      {:else}
        <div class="none">No parameter matches “{query.trim()}”</div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Tokens only (theme.css). The button fits the lane header's 18 px line. */
  .auto { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border: 0; border-radius: var(--r-sm); background: var(--raised) var(--gloss); box-shadow: var(--raised-shadow); color: var(--text); font: 500 var(--fs-lbl) var(--font-ui); white-space: nowrap; cursor: pointer; }
  .auto:hover:not(:disabled) { color: var(--text); background-color: color-mix(in srgb, var(--raised), var(--text) 8%); }
  .auto:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .auto:disabled { opacity: 0.5; cursor: default; }
  :global(.row.lane.compact) .auto { height: 15px; }
  .pop { position: fixed; z-index: 50; width: 240px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: var(--lift); }
  .pop input { flex: none; width: 100%; box-sizing: border-box; }
  .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; }
  .section { padding: 6px 6px 2px; color: var(--text-2); font: 600 var(--fs-xs) var(--font-ui); letter-spacing: 0.06em; text-transform: uppercase; }
  .row { flex: none; display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 6px; border-radius: var(--r-sm); color: var(--text); font: var(--fs-ctl) var(--font-ui); cursor: pointer; user-select: none; outline: none; }
  .row.group { font-weight: 600; }
  .row.item { padding-left: 24px; }
  .row.active { background: var(--raised); box-shadow: inset 2px 0 0 var(--accent); }
  .row.used { color: var(--text-2); cursor: default; }
  .row.used .name { opacity: 0.6; }
  .caret { display: inline-flex; color: var(--text-2); transition: rotate 0.12s; }
  .caret.open { rotate: 90deg; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { color: var(--text-2); font-size: var(--fs-lbl); }
  .note { color: var(--text-2); font-size: var(--fs-xs); white-space: nowrap; }
  .none { padding: 8px 6px; color: var(--text-2); font-size: var(--fs-ctl); }
</style>
