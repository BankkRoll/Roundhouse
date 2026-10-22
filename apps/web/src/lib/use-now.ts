import { useEffect, useState } from "react";

/**
 * Current time that re-renders the caller on an interval, for countdowns and "4s ago".
 *
 * @param intervalMs - Tick interval. Defaults to 1000.
 * @returns The current unix ms, refreshed every tick.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
