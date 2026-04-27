// Plan §H — jitter spreads scheduled task firings across a window so 200
// brands don't all hit the API at midnight UTC. Symmetric ±jitterMs around
// the planned fire time. Returns the offset in milliseconds (can be
// negative — fire earlier than the scheduled time).

export function applyJitter(jitterMs: number): number {
  if (jitterMs <= 0) return 0;
  return Math.floor((Math.random() * 2 - 1) * jitterMs);
}
