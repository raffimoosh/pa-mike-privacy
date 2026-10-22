import { toISODate, type ISODate } from "./dates.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and demos. */
export class FixedClock implements Clock {
  private current: Date;
  constructor(iso: string) {
    this.current = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(iso: string): void {
    this.current = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  }
  advanceDays(days: number): void {
    this.current.setUTCDate(this.current.getUTCDate() + days);
  }
}

export function todayISO(clock: Clock): ISODate {
  return toISODate(clock.now());
}

export function nowISO(clock: Clock): string {
  return clock.now().toISOString();
}
