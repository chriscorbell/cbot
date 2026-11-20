/** Makes an element glow once (`.is-glow` in base.css): where a search result lands. Calling it again restarts the glow. */
export function glow(el: HTMLElement) {
  el.classList.remove('is-glow');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-glow');
  const done = (e: AnimationEvent) => {
    if (e.target !== el || e.animationName !== 'glow-ring') return;
    el.classList.remove('is-glow');
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}

/** The folder a Library path is in: '' for the top. */
export const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
