// Visible navigation and progressive entry motion; no data access or passive focus changes.
const header = document.querySelector('.site-header');
header.classList.add('has-js');
function measureHeader() {
  document.documentElement.style.setProperty('--site-header-height', header.getBoundingClientRect().height + 'px');
}
measureHeader();
addEventListener('resize', measureHeader, { passive: true });
const revealMedia = matchMedia('(max-width:899px) and (prefers-reduced-motion:no-preference)');
let revealObserver = null;
function configureReveals() {
  if (!revealMedia.matches) {
    document.querySelectorAll('.motion-entered').forEach(element => element.classList.remove('motion-entered'));
    return;
  }
  if (!('IntersectionObserver' in window) || revealObserver) return;
  revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target;
      const anchor = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (revealMedia.matches && !element.contains(document.activeElement)
        && !(anchor && anchor.contains(element))) element.classList.add('motion-entered');
      revealObserver.unobserve(element);
    }
  }, { threshold: .12 });
  for (const element of document.querySelectorAll('.scroll-story .scene-copy, .scroll-story .scene > figure, .feature-gallery > figure')) revealObserver.observe(element);
}
configureReveals();
revealMedia.addEventListener('change', configureReveals);
document.addEventListener('focusin', event => event.target.closest('.motion-entered')?.classList.remove('motion-entered'));
document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || link.origin !== location.origin || link.pathname !== location.pathname || !link.hash) return;
  const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (!target) return;
  event.preventDefault();
  history.pushState(null, '', link.hash);
  target.querySelectorAll('.motion-entered').forEach(element => element.classList.remove('motion-entered'));
  target.classList.remove('motion-entered');
  target.scrollIntoView({ block: 'start' });
  const focus = target.id === 'main' ? target : target.querySelector('h1,h2,h3') || target;
  focus.tabIndex = -1;
  focus.focus({ preventScroll: true });
});
