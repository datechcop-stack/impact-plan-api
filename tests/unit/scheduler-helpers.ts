export function daysBetweenFixture(target: Date, now: Date): number {
  const start = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((start(target) - start(now)) / (24 * 60 * 60 * 1000));
}
