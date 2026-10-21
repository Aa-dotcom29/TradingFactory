'use client';

import { useEffect, useState } from 'react';
import { THEME_KEY } from '@/lib/theme';

// The rail's night-watch switch. The initial theme is applied by an inline
// script in the root layout, before paint; this button only reflects that state
// and lets the person override it. An explicit choice is stored, so it survives
// reloads and takes precedence over the 18:00-06:00 IST auto-dim.
export default function ThemeToggle() {
  const [theme, setTheme] = useState('day');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dim' ? 'dim' : 'day');
    setReady(true);
  }, []);

  const toggle = () => {
    const next = theme === 'dim' ? 'day' : 'dim';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage may be unavailable; the toggle still works for this session */
    }
  };

  const dim = theme === 'dim';
  return (
    <button
      type="button"
      className={`theme-toggle${dim ? ' dim' : ''}`}
      onClick={toggle}
      aria-pressed={dim}
      aria-label={dim ? 'Switch to the bright palette' : 'Switch to the night-watch dim palette'}
      title={dim ? 'Night watch: dim. Click for bright.' : 'Bright palette. Click for night watch.'}
      disabled={!ready}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        {dim
          ? <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
          : <><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9" /></>}
      </svg>
      <span>{dim ? 'Night' : 'Bright'}</span>
    </button>
  );
}
