'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// The workspace is a server component, so refreshing the router is enough to
// re-read quotes, flow and the trade row. Pauses while the tab is hidden so a
// forgotten window does not keep polling all night.
export default function LiveRefresh({ seconds = 15 }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      const active = document.activeElement;
      const tag = active && active.tagName ? active.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable)) {
        return;
      }
      router.refresh();
    };
    const id = setInterval(tick, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return <span className="tick">live refresh {seconds}s</span>;
}
