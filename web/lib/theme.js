// Night watch: after the Indian market closes and before it reopens, the
// interface drops to a dimmer palette so a late-evening check does not glare.
//
// The choice has three states, in priority order:
//   1. an explicit 'tf-theme' value the person set with the rail toggle,
//   2. otherwise the clock: dim between 18:00 and 06:00 IST,
//   3. otherwise the normal day palette.
//
// The inline script has to duplicate the hour rule because it runs before any
// bundle is parsed; `themeForHour` below is the single tested definition and
// the script must stay in step with it. The test in test/theme.test.js pins the
// boundary hours so the two cannot drift silently.

export const THEME_KEY = 'tf-theme';

export function themeForHour(hour) {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return 'day';
  return hour >= 18 || hour < 6 ? 'dim' : 'day';
}

export const THEME_SCRIPT = `(function(){try{var t=window.localStorage.getItem('${THEME_KEY}');if(t!=='dim'&&t!=='day'){var p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date());var h=0;for(var i=0;i<p.length;i++){if(p[i].type==='hour'){h=Number(p[i].value);}}t=(h>=18||h<6)?'dim':'day';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
