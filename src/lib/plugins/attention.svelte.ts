// Rail-level attention counters. [FRONTEND]
//
// A reminder is only useful when the panel is closed. The mail and calendar
// panels already cache their state locally, so the island can read the same
// namespaced keys and show a small badge without duplicating backend work:
//   * `mail.folder` → scan the chosen folder for unread headers (local only);
//   * `calendar`    → the next imported event, if it starts within 15 minutes.
// Refreshes are cheap and happen once a minute, plus immediately whenever a
// plugin writes its state (`island-plugin-state`).
import { scanMailFolder } from '$lib/api';
import { nextEvents, startsSoon, type CalendarEvent } from './ics';
import { readPluginState } from './storage';

interface CalendarCache {
  events: CalendarEvent[];
}

class Attention {
  mailUnread = $state(0);
  calendarSoon = $state(false);

  #timer: ReturnType<typeof setInterval> | null = null;
  #started = 0;
  #mailGeneration = 0;
  /** A switched-off module neither scans nor shows a badge. */
  #mailEnabled = true;
  #calendarEnabled = true;
  #onState = (event: Event) => {
    const plugin = (event as CustomEvent<string>).detail;
    if (plugin === 'mail.folder') void this.#refreshMail();
    else if (plugin === 'calendar') this.#refreshCalendar();
  };

  /**
   * Follow Settings → Plugins. Switching a module off clears its badge and
   * stops its work; switching it back on refreshes immediately when the
   * island is running.
   */
  configure(mail: boolean, calendar: boolean): void {
    if (mail === this.#mailEnabled && calendar === this.#calendarEnabled) return;
    const mailWas = this.#mailEnabled;
    const calendarWas = this.#calendarEnabled;
    this.#mailEnabled = mail;
    this.#calendarEnabled = calendar;
    if (!mail) {
      this.#mailGeneration += 1; // an in-flight scan may not restore the badge
      this.mailUnread = 0;
    }
    if (!calendar) this.calendarSoon = false;
    if (this.#started > 0 && ((mail && !mailWas) || (calendar && !calendarWas))) {
      void this.refresh();
    }
  }

  start(): void {
    this.#started += 1;
    if (this.#started > 1) return;
    window.addEventListener('island-plugin-state', this.#onState);
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), 60_000);
  }

  stop(): void {
    this.#started = Math.max(0, this.#started - 1);
    if (this.#started > 0) return;
    window.removeEventListener('island-plugin-state', this.#onState);
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async refresh(): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (this.#mailEnabled) jobs.push(this.#refreshMail());
    if (this.#calendarEnabled) this.#refreshCalendar();
    await Promise.all(jobs);
  }

  async #refreshMail(): Promise<void> {
    if (!this.#mailEnabled) {
      this.mailUnread = 0;
      return;
    }
    const generation = ++this.#mailGeneration;
    const folder = readPluginState<string | null>('mail.folder', null);
    if (typeof folder !== 'string' || !folder.trim()) {
      this.mailUnread = 0;
      return;
    }
    try {
      const scan = await scanMailFolder(folder, 1);
      // A slower scan for the previous folder must not overwrite the new one.
      if (generation === this.#mailGeneration) this.mailUnread = scan.unread;
    } catch {
      // A folder that was moved or is temporarily unavailable must not turn
      // into a permanent error badge; the panel shows the detail instead.
      if (generation === this.#mailGeneration) this.mailUnread = 0;
    }
  }

  #refreshCalendar(): void {
    if (!this.#calendarEnabled) {
      this.calendarSoon = false;
      return;
    }
    const cached = readPluginState<CalendarCache | null>('calendar', null);
    if (!cached || !Array.isArray(cached.events)) {
      this.calendarSoon = false;
      return;
    }
    const now = Date.now();
    const events = cached.events.filter(
      (event): event is CalendarEvent =>
        Boolean(event) && Number.isFinite(event.startMs) && Number.isFinite(event.endMs)
    );
    const next = nextEvents(events, now, 1)[0];
    this.calendarSoon = Boolean(next && startsSoon(next, now));
  }
}

export const attention = new Attention();
