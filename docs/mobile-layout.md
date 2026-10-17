# Mobile layout: verification and the one real bug it found

The dashboard's small-screen layout was authored from the start but never actually checked at a phone
width - the browser tooling has no device-emulation mode. This records how it was checked, the real bug
the check found, and the fix.

## How it was checked

A media query responds to its own **viewport**. An `<iframe>` is its own viewport, so loading a route
inside a fixed-width iframe exercises the phone breakpoints exactly as a phone would - without any
device emulation. The measurement is one number: does `documentElement.scrollWidth` exceed
`clientWidth`? If it does, the page scrolls sideways, which is the failure that makes a layout feel
broken on a phone.

Offenders were then classified: an element past the right edge is harmless if an ancestor has
`overflow-x: auto | scroll | hidden` (it is meant to scroll inside its own box), and a genuine fault if
nothing clips it.

Widths checked: **360, 390, 414** (phones), **768** (tablet), **1024, 1280** (desktop). Routes:
`/dashboard`, `/dashboard/intraday`, `/dashboard/swing`, `/dashboard/positional`, `/dashboard/settings`,
`/login`.

## A trap worth remembering

Run the check against a **production build** (`next build` then `next start`). Running `next build` and
then `next dev` in the same `.next` directory leaves the dev server serving a stale, effectively empty
CSS bundle - and with the stylesheet missing, `.table-scroll` stops clipping and the page reports ~400px
of phantom overflow. The first pass here was fooled by exactly that. `npm run web:build` and serve it;
do not trust a dev server that has had a build run underneath it.

## The real bug

At 360px the page was **736px wide** - a 391px overflow - and it was **not** the tables. Every table is
already wrapped in `.table-scroll`, and that wrapper was doing its job.

The cause was the grid defaults. `.stack` and `.grid` lay their children out as grid items, and a grid
item's `min-width` defaults to `auto`, which resolves to its *min-content* size. The pipeline strip
(`.pipe`) is `display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))`; under a
min-content constraint that resolves wide. So one wide child expanded the `.stack` column to ~722px,
and because every card shares that column, **every** card was dragged past the viewport - which is why
`.page-head`, the status banner, the pipeline strip and the tables all reported a ~722px width at once.

## The fix

```css
.grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.stack > *, .grid > * { min-width: 0; }
```

`minmax(0, 1fr)` lets the tracks shrink below their content; `min-width: 0` lets the items themselves
shrink. The wide children then live inside their own scroll containers instead of setting the column
width, which is what they were always meant to do.

## Result

After the fix, all six routes report **zero** page-level horizontal overflow at 360, 390, 414, 768,
1024 and 1280px, with no unclipped offenders. The wide tables scroll horizontally inside their cards
(the intended behaviour), and the pipeline strip reflows into columns that fit.

## Still open

- Verified by viewport width in a desktop browser, **not on a physical device**. No touch-target size
  audit, no iOS Safari or Android keyboard/address-bar behaviour, and no landscape pass.
- The tab bar scrolls horizontally by design (`.tabs { overflow-x: auto }`); on a narrow phone the
  last tab is reached by scrolling, not by wrapping.
