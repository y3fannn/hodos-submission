// Demo-only cooperative setup and delayed feedback. No financial data or persistence here.
export async function runDemoSteps(steps, {
  now = () => performance.now(),
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
  cancelled = () => false,
} = {}) {
  let deadline = now() + 8;
  try {
    while (true) {
      if (cancelled()) throw new DOMException('Demo setup cancelled', 'AbortError');
      if (steps.next().done) return;
      if (now() >= deadline) { await yieldControl(); deadline = now() + 8; }
    }
  } finally { steps.return?.(); }
}

export function beginDemoTransition() {
  const app = document.getElementById('app');
  const busy = app.getAttribute('aria-busy');
  const focus = document.activeElement;
  const regions = [...document.body.children].filter((el) => el.tagName !== 'SCRIPT');
  const inert = regions.map((el) => el.inert);
  const buttons = [...document.querySelectorAll('[data-action=demo]')];
  const disabled = buttons.map((el) => el.disabled);
  regions.forEach((el) => { el.inert = true; });
  buttons.forEach((el) => { el.disabled = true; });
  app.setAttribute('aria-busy', 'true');
  const overlay = document.createElement('div');
  overlay.className = 'demo-loading';
  overlay.hidden = true;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-label', 'Preparing demo');
  const ring = document.createElement('span');
  ring.className = 'demo-loading-ring';
  ring.setAttribute('aria-hidden', 'true');
  overlay.append(ring);
  document.body.append(overlay);
  let finished = false;
  const timer = setTimeout(() => { if (!finished) overlay.hidden = false; }, 200);
  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); overlay.remove();
    regions.forEach((el, i) => { el.inert = inert[i]; });
    buttons.forEach((el, i) => { el.disabled = disabled[i]; });
    if (busy === null) app.removeAttribute('aria-busy'); else app.setAttribute('aria-busy', busy);
    if (focus?.isConnected && !focus.inert) focus.focus({ preventScroll: true });
  };
}
