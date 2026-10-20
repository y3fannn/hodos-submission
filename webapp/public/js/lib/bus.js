// After-write hooks. Features register; transactions emit. Avoids import cycles.
const handlers = { write: [], open: [], recurring_posted: [] };
export const on = (ev, fn) => { (handlers[ev] ||= []).push(fn); };
export const emit = (ev, payload) => { for (const fn of handlers[ev] || []) { try { fn(payload); } catch (e) { console.error(ev, e); } } };
