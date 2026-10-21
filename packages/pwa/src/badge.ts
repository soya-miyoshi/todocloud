// The app-icon badge: how many tasks have reached today.
//
// A task counts when it is open and either date has arrived — due today or on
// an earlier day, or deferred until today or an earlier day. Both, because the
// two say different things and either is a reason to look: a due date is a
// deadline that has come, a defer date is work that has just become
// available. Whole calendar days, in UTC, the same frame `forecast.ts` and
// `--due 2026-11-01` use, so a task due at 18:00 counts at breakfast.
//
// The Badging API is honoured on iOS 16.4+ only for an app installed to the
// Home Screen, and only once the user has granted notification permission;
// without it the call is accepted and nothing is drawn. Everywhere the API is
// missing, this does nothing, which is the truthful reading: there is no
// badge to keep right.

import { calendarDays, inForecast } from '@todocloud/core/forecast';
import type { Task } from '@todocloud/core/task';

/** Badge is the `navigator` slice that sets and clears the app badge. */
export interface Badge {
  setAppBadge(count: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

/** badge returns the app-badge API, or undefined where the browser has none. */
export function badge(global: typeof globalThis = globalThis): Badge | undefined {
  const nav = (global as unknown as { navigator?: Partial<Badge> }).navigator;
  if (typeof nav?.setAppBadge !== 'function' || typeof nav.clearAppBadge !== 'function') {
    return undefined;
  }
  return nav as Badge;
}

/**
 * arrived counts the tasks whose due or defer day is today or earlier.
 * Finished, dropped and deleted tasks, and anything that is not a task, are
 * left out by `inForecast`.
 */
export function arrived(tasks: readonly Task[], now: Date): number {
  let n = 0;
  for (const t of tasks) {
    if (!inForecast(t)) {
      continue;
    }
    if (
      (t.dueAt !== undefined && calendarDays(t.dueAt, now) <= 0) ||
      (t.deferAt !== undefined && calendarDays(t.deferAt, now) <= 0)
    ) {
      n++;
    }
  }
  return n;
}

/**
 * showBadge draws the count, or clears the badge at zero. A refusal is
 * swallowed: a badge is a courtesy, and a browser that declines it must not
 * break the page.
 */
export async function showBadge(api: Badge | undefined, count: number): Promise<void> {
  if (api === undefined) {
    return;
  }
  try {
    await (count > 0 ? api.setAppBadge(count) : api.clearAppBadge());
  } catch {
    // No permission, or not installed: nothing to draw, nothing to report.
  }
}
