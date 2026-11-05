// The built-in island plugin list. [FRONTEND]
//
// This is the only place the shell learns which plugins exist. Add an entry +
// a panel component here and the tool rail picks it up; no other file changes.
// The `label`/`hint` values are i18n keys so the rail follows the app language.
import type { IslandPlugin } from './types';
import CalendarPanel from './panels/CalendarPanel.svelte';
import DropPanel from './panels/DropPanel.svelte';
import MailPanel from './panels/MailPanel.svelte';
import MusicPanel from './panels/MusicPanel.svelte';
import NotesPanel from './panels/NotesPanel.svelte';
import ProvidersPanel from './panels/ProvidersPanel.svelte';
import SessionsPanel from './panels/SessionsPanel.svelte';
import TasksPanel from './panels/TasksPanel.svelte';
import TimerPanel from './panels/TimerPanel.svelte';
import WechatPanel from './panels/WechatPanel.svelte';

const REGISTERED: IslandPlugin[] = [
  {
    id: 'providers',
    label: 'plugin.providers',
    hint: 'plugin.providers.hint',
    // sliders
    icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
    order: 0,
    component: ProvidersPanel,
  },
  {
    id: 'calendar',
    label: 'plugin.calendar',
    hint: 'plugin.calendar.hint',
    // calendar sheet
    icon: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1ZM8 12h3M8 16h3M14 12h2',
    order: 8,
    component: CalendarPanel,
  },
  {
    id: 'mail',
    label: 'plugin.mail',
    hint: 'plugin.mail.hint',
    // envelope
    icon: 'M3 6h18v12H3zM3 7l9 6 9-6',
    order: 9,
    component: MailPanel,
  },
  {
    id: 'notes',
    label: 'plugin.notes',
    hint: 'plugin.notes.hint',
    // note + lines
    icon: 'M5 4h10l4 4v12H5zM15 4v5h5M8 12h8M8 16h6',
    order: 10,
    component: NotesPanel,
  },
  {
    id: 'wechat',
    label: 'plugin.wechat',
    hint: 'plugin.wechat.hint',
    // two chat dots in a bubble
    icon: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-3-.5L3 21l1.6-4.4A8.4 8.4 0 1 1 21 11.5ZM8 11h.01M12 11h.01M16 11h.01',
    order: 11,
    component: WechatPanel,
  },
  {
    id: 'tasks',
    label: 'plugin.tasks',
    hint: 'plugin.tasks.hint',
    // check mark
    icon: 'M4 12l5 5L20 6',
    order: 12,
    component: TasksPanel,
  },
  {
    id: 'sessions',
    label: 'plugin.sessions',
    hint: 'plugin.sessions.hint',
    // recent activity (list)
    icon: 'M4 6h16M4 12h10M4 18h7',
    order: 15,
    component: SessionsPanel,
  },
  {
    id: 'music',
    label: 'plugin.music',
    hint: 'plugin.music.hint',
    // music note
    icon: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3ZM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z',
    order: 18,
    component: MusicPanel,
  },
  {
    id: 'timer',
    label: 'plugin.timer',
    hint: 'plugin.timer.hint',
    // clock
    icon: 'M12 8v5l3 2M9 2h6M12 4a8 8 0 1 0 8 8',
    order: 20,
    component: TimerPanel,
  },
  {
    id: 'drop',
    label: 'plugin.drop',
    hint: 'plugin.drop.hint',
    // tray with an arrow into it
    icon: 'M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
    order: 25,
    component: DropPanel,
  },
];

/** `order` is authoritative, so a new entry cannot accidentally jump the rail. */
export const ISLAND_PLUGINS: IslandPlugin[] = REGISTERED.slice().sort((a, b) => a.order - b.order);

export function pluginById(id: string): IslandPlugin | null {
  return ISLAND_PLUGINS.find((plugin) => plugin.id === id) ?? null;
}
