// App-wide banners shown at the top of the bottom panel: `error` (red,
// role=alert) and `notice` (yellow, e.g. a sample waiting for Stop). Shared
// so that code outside the step grid (e.g. App's window-level drop guard) can
// raise them too. null = hidden.
export const banners = $state<{ error: string | null; notice: string | null }>({
  error: null,
  notice: null,
});
