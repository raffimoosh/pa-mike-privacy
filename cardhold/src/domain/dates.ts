/** Calendar dates are plain `YYYY-MM-DD` strings so scheduling is timezone-proof. */
export type ISODate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertISODate(s: string): ISODate {
  if (!ISO_DATE.test(s)) throw new Error(`Expected YYYY-MM-DD date, got ${s}`);
  return s;
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** ISO dates compare correctly as strings. */
export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
