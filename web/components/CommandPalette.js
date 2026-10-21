'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { istStamp } from '@/lib/format';

// Ctrl/Cmd-K and a few one-key jumps, plus a searchable index of pages,
// workers, tracked names and published signals. Everything here is navigation:
// the palette never mutates state, so it cannot be a path to an unintended
// trade. Shortcuts are ignored while a field has focus unless it is the
// palette's own input.

const GO = {
  o: '/dashboard',
  i: '/dashboard/intraday',
  s: '/dashboard/swing',
  p: '/dashboard/positional',
  t: '/dashboard/trades',
  a: '/dashboard/arcade',
  c: '/dashboard/settings',
};

const SHORTCUTS = [
  { keys: 'Ctrl K', what: 'open this palette' },
  { keys: 'g then o', what: 'go to Overview' },
  { keys: 'g then i', what: 'go to Intraday' },
  { keys: 'g then s', what: 'go to Swing' },
  { keys: 'g then p', what: 'go to Positional' },
  { keys: 'g then t', what: 'go to Trades' },
  { keys: 'g then a', what: 'go to the agents workspace' },
  { keys: 'g then c', what: 'go to Settings' },
  { keys: '?', what: 'show this list' },
  { keys: 'Esc', what: 'close' },
];

export default function CommandPalette() {
  const router = useRouter();
  const inputRef = useRef(null);
  const goTimer = useRef(null);
  const goArmed = useRef(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
  }, []);

  const go = useCallback((href) => {
    close();
    router.push(href);
  }, [close, router]);

  useEffect(() => {
    const onKey = (event) => {
      const target = event.target;
      const typing = target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT'
        || target.isContentEditable
      );

      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === 'Escape') {
        if (open) close();
        return;
      }
      if (typing) return;

      if (event.key === '?') {
        event.preventDefault();
        setQ('');
        setOpen(true);
        return;
      }

      if (goArmed.current) {
        goArmed.current = false;
        const href = GO[String(event.key).toLowerCase()];
        if (href) {
          event.preventDefault();
          go(href);
        }
        return;
      }

      if (String(event.key).toLowerCase() === 'g') {
        goArmed.current = true;
        if (goTimer.current) clearTimeout(goTimer.current);
        goTimer.current = setTimeout(() => { goArmed.current = false; }, 1200);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (goTimer.current) clearTimeout(goTimer.current);
    };
  }, [close, go, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (!term) {
      setGroups([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
        const data = res.ok ? await res.json() : { groups: [] };
        setGroups(Array.isArray(data.groups) ? data.groups : []);
      } catch {
        setGroups([]);
      } finally {
        setLoading(false);
      }
    }, 140);
    return () => clearTimeout(handle);
  }, [q, open]);

  useEffect(() => {
    setActive(0);
  }, [groups]);

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(0, flat.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[active];
      if (item) go(item.href);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <>
      <button
        type="button"
        className="palette-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search and navigate (Ctrl K)"
      >
        <span>Search</span>
        <span className="tick">Ctrl K</span>
      </button>

      {open ? (
        <div className="cmdk-backdrop" onMouseDown={close} role="presentation">
          <div
            className="cmdk"
            role="dialog"
            aria-modal="true"
            aria-label="Search and navigate"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <input
              ref={inputRef}
              className="cmdk-input"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search symbols, signals, workers, pages"
              aria-label="Search"
              autoComplete="off"
              spellCheck="false"
            />

            <div className="cmdk-body">
              {loading ? <div className="cmdk-empty">Searching...</div> : null}

              {!q.trim() ? (
                <div className="cmdk-group">
                  <div className="cmdk-group-label">Shortcuts</div>
                  {SHORTCUTS.map((shortcut) => (
                    <div className="cmdk-help" key={shortcut.keys}>
                      <span className="mono">{shortcut.keys}</span>
                      <span className="muted">{shortcut.what}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {!loading && q.trim() && !flat.length ? (
                <div className="cmdk-empty">No matches for &ldquo;{q.trim()}&rdquo;</div>
              ) : null}

              {q.trim()
                ? groups.map((group) => (
                  <div className="cmdk-group" key={group.label}>
                    <div className="cmdk-group-label">{group.label}</div>
                    {group.items.map((item) => {
                      const index = flat.indexOf(item);
                      return (
                        <button
                          type="button"
                          key={`${group.label}-${item.href}-${item.title}`}
                          className={`cmdk-item${index === active ? ' active' : ''}`}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => go(item.href)}
                        >
                          <span className="cmdk-title">
                            {item.title}
                            {item.tone ? <span className={`dot ${item.tone}`} aria-hidden="true" /> : null}
                          </span>
                          <span className="cmdk-sub muted">{item.sub}</span>
                          {item.at ? <span className="cmdk-at mono">{istStamp(item.at)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))
                : null}
            </div>

            <div className="cmdk-foot">
              <span className="tick">Up/Down navigate</span>
              <span className="tick">Enter open</span>
              <span className="tick">Esc close</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
