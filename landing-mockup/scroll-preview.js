// Shared presentation: the full website opts into paced input; the reference keeps free scrolling.
const media = matchMedia('(min-width:900px) and (min-height:700px) and (prefers-reduced-motion:no-preference)');
const FADE_MS = 600;
const clamp = value => Math.min(1, Math.max(0, value));
function createScrollStory(story) {
  const stage = story.querySelector('.story-stage');
  const scenes = [...stage.querySelectorAll('.scene')];
  const copies = scenes.map(scene => scene.querySelector('.scene-copy'));
  const header = document.querySelector('.site-header, .preview-header');
  const unit = index => scenes.map((_, i) => Number(i === index));
  let phone = null, transcript = null, frame = 0, target = -1, motion = null, headerHeight = -1;
  let weights = [], words = [];
  const paced = story.hasAttribute('data-step-lock');
  const mixedMedia = story.dataset.mediaLayout === 'left';
  let lastWheel = -Infinity, lastWheelDirection = 0, gesturePeak = 0, gestureLow = Infinity;
  let touchY = null, touchStepped = false, escaped = false;
  function geometry() {
    const height = header.getBoundingClientRect().height;
    return { start: story.getBoundingClientRect().top + scrollY - height,
      travel: Math.max(1, story.offsetHeight - stage.offsetHeight) };
  }
  function inputStep(delta, event) {
    if (!paced || !phone || event.defaultPrevented || !delta) return false;
    const {start, travel} = geometry(), end = start + travel;
    const active = scrollY >= start - 1 && scrollY <= end + 1;
    if (!active) {
      escaped = false;
      // A large wheel must land at the first panel, not fly over the whole section.
      if ((delta > 0 && scrollY < start && scrollY + delta >= start)
        || (delta < 0 && scrollY > end && scrollY + delta <= end)) {
        event.preventDefault(); scrollTo(0, delta > 0 ? start : end); requestRender(); return true;
      }
      return false;
    }
    if (escaped) return false;
    event.preventDefault();
    if (motion) return true;
    const next = target + Math.sign(delta);
    let position = start + travel * (next + .05) / scenes.length;
    if (next < 0) position = start - 2;
    else if (next >= scenes.length) position = end + 2;
    scrollTo(0, position); requestRender(); return true;
  }
  function wheel(event) {
    if (!paced || event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    let multiplier = 1;
    if (event.deltaMode === 1) multiplier = 16;
    else if (event.deltaMode === 2) multiplier = innerHeight;
    const delta = event.deltaY * multiplier;
    if (!delta) return;
    const now = performance.now(), direction = Math.sign(delta);
    // Compare a renewed push with the gesture's decayed low point, not just
    // the previous event. Continuing acceleration alone cannot re-arm a step.
    const magnitude = Math.abs(delta);
    const quiet = now - lastWheel >= 140;
    const reversed = direction !== lastWheelDirection && magnitude >= 4;
    if (!quiet && !reversed) {
      gesturePeak = Math.max(gesturePeak, magnitude);
      if (magnitude <= gesturePeak * .5 && gesturePeak - magnitude >= 2)
        gestureLow = Math.min(gestureLow, magnitude);
    }
    const renewed = magnitude - gestureLow >= 4;
    const fresh = quiet || reversed || renewed;
    lastWheel = now;
    // Tiny sign jitter in a tail must not erase a deliberate direction.
    if (fresh || magnitude >= 4) lastWheelDirection = direction;
    // Consume even mid-fade gestures; do not queue them for after the hold.
    if (fresh) { gesturePeak = magnitude; gestureLow = Infinity; }
    const {start, travel} = geometry();
    if (phone && !escaped && scrollY >= start - 1 && scrollY <= start + travel + 1 && !fresh) {
      event.preventDefault(); return;
    }
    inputStep(delta, event);
  }
  function key(event) {
    if (!paced || event.ctrlKey || event.metaKey || event.altKey
      || event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'Escape') { escaped = true; settle(); return; }
    const delta = ({ArrowDown:1,PageDown:1,ArrowUp:-1,PageUp:-1,' ':event.shiftKey?-1:1})[event.key];
    if (!delta) return;
    if (event.repeat) {
      const {start,travel} = geometry();
      if (phone && !escaped && scrollY >= start - 1 && scrollY <= start + travel + 1) event.preventDefault();
      return;
    }
    inputStep(delta * innerHeight, event);
  }
  if (paced) {
    addEventListener('wheel', wheel, {passive:false});
    addEventListener('keydown', key);
    addEventListener('touchstart', event => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; touchStepped = false; }, {passive:true});
    addEventListener('touchmove', event => {
      if (touchY === null || event.touches.length !== 1 || !phone || event.defaultPrevented) return;
      const delta = touchY - event.touches[0].clientY, {start,travel} = geometry();
      if (scrollY >= start - 1 && scrollY <= start + travel + 1 && !escaped && (touchStepped || Math.abs(delta) < 30)) event.preventDefault();
      else if (!touchStepped && inputStep(delta,event)) touchStepped = true;
    }, {passive:false});
    addEventListener('touchend', () => { touchY = null; }, {passive:true});
  }
  story.style.setProperty('--scene-count', String(scenes.length));
  function selectedScene() {
    const height = header.getBoundingClientRect().height;
    if (height !== headerHeight) {
      headerHeight = height;
      story.style.setProperty('--story-header', height + 'px');
    }
    const start = story.getBoundingClientRect().top + scrollY - height;
    const travel = Math.max(1, story.offsetHeight - stage.offsetHeight);
    const step = clamp((scrollY - start) / travel) * scenes.length;
    return Math.min(scenes.length - 1, Math.floor(step + .25));
  }
  function advance(now) {
    if (!motion) return;
    const progress = clamp((now - motion.start) / FADE_MS);
    weights = motion.weights.map((value, index) => value * (1 - progress) + (index === target ? progress : 0));
    words = motion.words.map((value, index) => index === target
      ? value + (1 - value) * clamp(progress * 2 - 1)
      : value * (1 - clamp(progress * 2)));
    if (progress === 1) motion = null;
  }
  function paint() {
    // Convert visible contributions to opaque stacked images, including interrupted mixtures.
    let below = 0;
    scenes.forEach((_, index) => {
      below += weights[index];
      phone.children[index].style.opacity = String(below > 0 ? weights[index] / below : 0);
      copies[index].style.opacity = String(words[index]);
    });
    story.dataset.scene = String(target);
    story.dataset.position = weights.reduce((sum, value, index) => sum + value * index, 0).toFixed(3);
    story.dataset.animating = String(Boolean(motion));
    story.dataset.fadeDuration = String(FADE_MS);
  }
  function render(now = performance.now()) {
    frame = 0;
    if (!phone) return;
    advance(now);
    const next = selectedScene();
    if (next !== target) {
      target = next;
      motion = { start: now, weights: [...weights], words: [...words] };
    }
    paint();
    if (motion) requestRender();
  }
  function requestRender() { if (!frame && phone) frame = requestAnimationFrame(render); }
  function cancelFrame() { if (frame) cancelAnimationFrame(frame); frame = 0; }
  function settle() {
    cancelFrame();
    if (!phone) return;
    motion = null;
    weights = unit(target); words = [...weights];
    paint();
  }
  function contentFits() {
    const available = innerHeight - header.getBoundingClientRect().height - 48;
    return media.matches && (!mixedMedia || available * 7 / 13 >= 330)
      && Math.max(...copies.map(copy => copy.getBoundingClientRect().height)) <= available;
  }
  function configure() {
    cancelFrame();
    if (phone) phone.remove();
    if (transcript) transcript.remove();
    phone = transcript = motion = null;
    target = -1; weights = []; words = [];
    story.classList.remove('is-pinned');
    stage.removeAttribute('aria-hidden');
    copies.forEach(copy => copy.style.removeProperty('opacity'));
    escaped = false; lastWheel = -Infinity; lastWheelDirection = 0;
    gesturePeak = 0; gestureLow = Infinity; touchY = null;
    for (const key of ['scene', 'position', 'animating', 'fadeDuration']) delete story.dataset[key];
    if (!contentFits()) return;
    phone = document.createElement(mixedMedia ? 'div' : 'figure');
    phone.className = mixedMedia ? 'shared-phone shared-media' : 'phone shared-phone';
    for (const scene of scenes) {
      if (mixedMedia) {
        const layer = document.createElement('div');
        layer.className = 'media-layer';
        const visual = scene.querySelector('figure').cloneNode(true);
        visual.querySelectorAll('img').forEach(image => image.loading = 'eager');
        layer.append(visual);
        phone.append(layer);
      } else {
        // Keep the approved reference's direct IMG stack and timing unchanged.
        const image = scene.querySelector('img').cloneNode(true);
        image.loading = 'eager';
        phone.append(image);
      }
    }
    // The static equivalent stays complete, with no duplicated navigation IDs or feature markers.
    transcript = document.createElement('div');
    transcript.className = 'sr-only';
    transcript.setAttribute('aria-label', story.getAttribute('aria-label') || 'Complete conversation');
    for (const scene of scenes) {
      const copy = scene.cloneNode(true);
      for (const node of [copy, ...copy.querySelectorAll('[id],[data-scene],[data-feature]')]) {
        for (const attribute of ['id', 'data-scene', 'data-feature']) node.removeAttribute(attribute);
      }
      copy.className = 'narrative-step';
      transcript.append(copy);
    }
    stage.append(phone);
    story.append(transcript);
    stage.setAttribute('aria-hidden', 'true');
    story.classList.add('is-pinned');
    target = selectedScene(); weights = unit(target); words = [...weights];
    render();
  }
  addEventListener('scroll', requestRender, { passive: true });
  addEventListener('resize', () => {
    if (Boolean(phone) !== contentFits()) configure(); else requestRender();
  }, { passive: true });
  media.addEventListener('change', configure);
  addEventListener('pagehide', settle);
  addEventListener('pageshow', requestRender);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) settle(); else requestRender();
  });
  configure();
}
document.querySelectorAll('.scroll-story').forEach(createScrollStory);
