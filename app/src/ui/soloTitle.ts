// The Solo buttons' tooltip text (track headers, mixer strips). Solo is
// exclusive; a modifier-click adds the track to the soloed ones
// (mixer-actions toggleSolo `additive`: Cmd, Ctrl or Shift). On macOS
// Ctrl-click is the context menu (no click event), so the title names
// ⌘ / Shift there and Ctrl / Shift elsewhere.

/** The platform is macOS (or iOS): ⌘ is the command key and Ctrl-click is a right-click. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier-clicks that add to the solo, as the title says them. */
export function soloAddClick(mac = IS_MAC): string {
  return mac ? '⌘/Shift-click' : 'Ctrl/Shift-click';
}

/** The Solo button's title for track `name` (`extra`: e.g. "; returns keep playing"). */
export function soloTitle(name: string, soloed: boolean, extra = '', mac = IS_MAC): string {
  return soloed
    ? `${name} is soloed — click to unsolo`
    : `Solo ${name}: play only this track${extra} (${soloAddClick(mac)}: add it to the soloed ones)`;
}
