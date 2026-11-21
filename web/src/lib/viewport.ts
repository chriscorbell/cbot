/**
 * Phone keyboards. iOS Safari keeps the page its full height when the keyboard opens and pans it up
 * instead, which pushes the header out of sight and leaves the composer floating on top of a scrolled
 * page. Following the visual viewport keeps the app exactly as tall as what is visible: the header
 * stays put and the composer sits on the keyboard, as in a native chat app.
 *
 * `--app-h` is set on <html> only while the visible part is shorter than the page (the keyboard is
 * up); otherwise the CSS falls back to 100%. A pinch zoom also shrinks the visual viewport, so a
 * zoomed page is left alone.
 */
export function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const zoomed = vv.scale > 1.01;
      // The layout viewport's height, which a keyboard leaves alone (innerHeight can follow it).
      const short = !zoomed && root.clientHeight - vv.height > 40;
      if (short) root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      else root.style.removeProperty('--app-h');
      // The page never scrolls on its own; undo the pan iOS adds when an input takes focus, and
      // bring the field into sight within its own scrolling sheet instead.
      if (!zoomed && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
      const field = document.activeElement;
      if (short && field instanceof HTMLElement && field.matches('input, textarea, [contenteditable="true"]')) field.scrollIntoView({ block: 'nearest' });
    });
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    root.style.removeProperty('--app-h');
  };
}
