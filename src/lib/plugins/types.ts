// Island plugin contract. [FRONTEND]
//
// A plugin is a small, self-contained panel that lives inside the expanded
// dynamic island. The shell owns placement, sizing, keyboard focus and
// settings; a plugin only renders its own content and may close itself.
//
// The contract is deliberately tiny so a future native/third-party plugin
// host can implement the same surface (see docs/ISLAND.md). Plugins are
// frontend-first for now: a panel cannot poll a provider, read credentials or
// move a window. Anything that needs the backend must go through an explicit
// command, exactly like the dashboard does.
import type { Component } from 'svelte';

/** Props every panel component receives. */
export interface PluginContext {
  /** Close the panel without changing the active plugin elsewhere. */
  close: () => void;
}

export interface IslandPlugin {
  /** Stable id; also the localStorage namespace and the persist key. */
  id: string;
  /** i18n key used as the tooltip / accessible name. */
  label: string;
  /** Optional i18n key for a one-line description in the panel header. */
  hint?: string;
  /**
   * 24×24 SVG path data drawn with `fill="none"` and `stroke="currentColor"`.
   * Keeping it a path (not a component) lets the registry stay rune-free.
   */
  icon: string;
  /** Lower numbers sit first in the tool rail. */
  order: number;
  /**
   * Panel body. `any` rather than `Component<PluginContext>` because a panel
   * may declare no props at all while still being rendered with `close`
   * available; the shell only ever passes that one optional-looking prop.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
}
