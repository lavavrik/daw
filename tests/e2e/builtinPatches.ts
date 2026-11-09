// The patch menu's contract, in order: app/src/state/patches.ts
// BUILTIN_GROUPS and housePatches.ts HOUSE_GROUPS. App code is not
// importable from the e2e tests (catalog.json's import attribute), so the
// lists are spelled out here, once: adding a patch means updating this file
// (patches.test.ts pins the same names on the app side). house.spec.ts
// checks the menu against it; serial.spec.ts and rackwidths.spec.ts read
// their house patch lists from it.

export const BUILTIN_GROUPS = [
  { label: 'Starter', patches: ['Deep Bass', 'Chord Stab', 'Pad', 'Lead', 'Pluck'] },
  { label: 'Sampler', patches: ['Sampler'] }, // plan 15: silent until a sample is dropped
  { label: 'House · Leads & Stabs', patches: ['Sax', 'Brass Stab', 'Supersaw Lead', 'Hoover'] },
  { label: 'House · Plucks', patches: ['Arp Pluck', 'Soft Pluck', 'Bright Pluck'] },
  { label: 'House · Keys', patches: ['Tine Keys', 'Piano Stab', 'Garage Organ', '90s Organ', 'FM Bell'] },
  { label: 'House · Bass', patches: ['Organ Bass', 'Reese Bass', 'Acid Line', 'Sub Bass'] },
  { label: 'House · Pads', patches: ['Strings', 'Warm Pad', 'Formant Pad'] },
  { label: 'House · FX', patches: ['Noise Sweep', 'Impact'] }, // plan 28: the Transition tracks' patches
];

/** Every patch in a 'House ·' group, in menu order (the FX ones included). */
export const HOUSE_PATCHES = BUILTIN_GROUPS.filter((g) => g.label.startsWith('House')).flatMap((g) => g.patches);

/** Plan 28's new house patches (each has an example roll). */
export const PLAN28_PATCHES = ['Supersaw Lead', 'Hoover', 'Soft Pluck', 'Bright Pluck', '90s Organ', 'FM Bell', 'Formant Pad'];
