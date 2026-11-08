// The last live note (plan 15 Task 5): the pitch of the most recent played
// note-on (QWERTY piano or MIDI, input/noteInput.ts; App sets it from the
// bus's onNoteOn), or null until one has arrived since the page loaded. UI
// state only, never saved. The Sample Player's "Root ← last note" button
// (ui/rack/ModulePanel.svelte) reads it.
//
// `seq` counts every live note-on (plan 17): the same pitch played twice
// changes nothing in `note`, so the Acid tab's step entry
// (ui/acid/AcidSteps.svelte) reacts to `seq` instead.
export const lastLive = $state<{ note: number | null; seq: number }>({ note: null, seq: 0 });
