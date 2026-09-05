import { useEffect, useState } from 'react';

export type MotionState = 'enter' | 'exit';

/** Keeps an exiting surface mounted for the longest transition token. */
export function useMotionPresence(visible: boolean): { rendered: boolean; state: MotionState } {
  const [rendered, setRendered] = useState(visible);
  const [state, setState] = useState<MotionState>(visible ? 'enter' : 'exit');

  useEffect(() => {
    if (visible) {
      setRendered(true);
      setState('enter');
      return;
    }
    if (!rendered) return;
    setState('exit');
    const fallback = window.setTimeout(() => setRendered(false), 320);
    return () => window.clearTimeout(fallback);
  }, [rendered, visible]);

  return { rendered, state };
}
