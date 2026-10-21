'use client';

import { useEffect } from 'react';

// Scroll reveal.
//
// Panels rise into place as they enter the viewport. It is the motion
// signature that makes a long page feel composed rather than dumped, and it
// costs one observer and no layout thrash.
//
// The first screen is revealed immediately: a page that starts blank and
// fades in reads as slower, not faster.
//
// Everything here is inert under prefers-reduced-motion - the CSS shows
// revealed panels outright, so the observer simply does nothing.

const SELECTOR = 'main .stack > *, main section.card, main .grid > *';

export default function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const nodes = Array.from(document.querySelectorAll(SELECTOR));
    if (!nodes.length) return undefined;

    nodes.forEach((node, index) => {
      node.classList.add('reveal');
      // The first two panels are above the fold on every page, so they are
      // shown at once instead of being made to wait for a scroll.
      if (index < 2) node.classList.add('is-first', 'is-revealed');
    });

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });

    for (const node of nodes) observer.observe(node);

    return () => {
      observer.disconnect();
      for (const node of nodes) {
        node.classList.remove('reveal', 'is-revealed', 'is-first');
      }
    };
  }, []);

  return null;
}
