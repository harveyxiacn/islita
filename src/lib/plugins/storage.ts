// Per-plugin, per-viewer storage. [FRONTEND]
//
// localStorage is per webview origin: it survives app restarts and settings
// reloads, but never leaves this machine and is not shared with the dashboard
// window. Every access is guarded: a private window, cleared site data or a
// storage quota error must leave the island usable rather than crash it.
const PREFIX = 'island.plugin.';

export function readPluginState<T>(plugin: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + plugin);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePluginState(plugin: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + plugin, JSON.stringify(value));
    announce(plugin);
  } catch {
    // storage disabled or full: the plugin keeps working in memory
  }
}

/** Same-window `storage` events do not fire; the shell listens for this. */
function announce(plugin: string): void {
  try {
    window.dispatchEvent(new CustomEvent('island-plugin-state', { detail: plugin }));
  } catch {
    // older webview / non-browser context
  }
}

export function removePluginState(plugin: string): void {
  try {
    localStorage.removeItem(PREFIX + plugin);
    announce(plugin);
  } catch {
    // ignore
  }
}
