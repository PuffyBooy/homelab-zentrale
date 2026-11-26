import { useEffect, useState } from 'react';

/** Current time, refreshed every `ms` (for countdowns and "vor 4 Min"). */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
