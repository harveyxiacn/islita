// Island-level "the pet has something to say" state. [FRONTEND]
//
// The sidebar window notes ring crossings, provider failures and completed
// tasks here; the pet panel reads them and marks them seen. It deliberately
// lives outside the panel so an event can raise the pet's rail dot while the
// panel is closed, then be waiting when the user opens it.
import type { PetSituation } from './speech';

const DEFAULT_MAX_AGE_MS = 10 * 60_000;

class PetSpeechStore {
  /** Most recent event, kept after it is read so the panel can still show it. */
  latest = $state<PetSituation | null>(null);
  at = $state(0);
  /** A newer event the panel has not shown yet; drives the rail dot. */
  unread = $state(false);

  note(situation: PetSituation, now = Date.now()) {
    this.latest = situation;
    this.at = now;
    this.unread = true;
  }

  /** The latest event while it is still worth showing, otherwise null. */
  current(maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now()): PetSituation | null {
    if (!this.latest || now - this.at > maxAgeMs) return null;
    return this.latest;
  }

  /** The panel is visible: no new-event dot, but keep the line for display. */
  seen() {
    this.unread = false;
  }

  clear() {
    this.latest = null;
    this.at = 0;
    this.unread = false;
  }
}

export const petSpeech = new PetSpeechStore();
