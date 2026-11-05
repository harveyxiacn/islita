// Which island plugins are switched on. [FRONTEND]
//
// `disabledPlugins` is an opt-out list: a plugin that is not named there is
// enabled. That way a plugin added in a later release appears for existing
// users without a settings migration, and "enable all" is the empty list.
// Pure module so the rail, the settings cards and the unit tests share it.

/** True unless the id is in the opt-out list. */
export function isPluginEnabled(id: string, disabled: readonly string[]): boolean {
  return !disabled.includes(id);
}

/** Registry order preserved; unknown ids in `disabled` are ignored. */
export function enabledPlugins<T extends { id: string }>(
  plugins: readonly T[],
  disabled: readonly string[]
): T[] {
  if (disabled.length === 0) return plugins.slice();
  const off = new Set(disabled);
  return plugins.filter((plugin) => !off.has(plugin.id));
}

/**
 * Return a new opt-out list with `id` switched on or off. Every existing copy
 * of `id` is dropped first, so flipping a switch twice leaves one entry at
 * most; unrelated ids and their order are kept. The backend de-duplicates
 * defensively as well.
 */
export function withPluginEnabled(
  disabled: readonly string[],
  id: string,
  enabled: boolean
): string[] {
  const next = disabled.filter((value) => value !== id);
  if (!enabled) next.push(id);
  return next;
}
