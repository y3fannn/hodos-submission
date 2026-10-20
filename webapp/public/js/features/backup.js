// Backups, and the reminder to make one. The data lives only on this device, so a lost phone or a
// browser clearing its storage loses it unless a backup exists. PRD Q6; design/2026-09-19-security.md §3.
// Cloud backup and full recovery remain unapproved: design/2026-10-06-recovery.md.
import { store, nowIso } from "../lib/store.js";
import * as vault from "../lib/vault.js";
import { session } from "../lib/session.js";
import { field, modal, toast, esc, commitFormAction, commitAction } from "../lib/ui.js";
import { today } from "./profile.js";

export const REMIND = { week: 7, month: 30, off: null };
const DAY = 86400000;
export const state = () => store.one("backup_state") || { last_backup_at: null, remind: "week", snooze_until: null };
const setState = (patch) => store.upsertOne("backup_state", { ...state(), ...patch });
export const setRemind = (remind) => setState({ remind: REMIND[remind] !== undefined ? remind : "week" });

// What changed since the last backup: rows written after it, not counting this bookkeeping or alerts.
export function changesSince(ts) {
  const skip = new Set(["backup_state", "alerts", "fx_rates", "home_layout"]);
  let n = 0;
  for (const t of store.tables()) if (!skip.has(t)) for (const r of store.all(t, { includeDeleted: true })) if (!ts || (r.updated_at || r.created_at) > ts) n++;
  return n;
}
// Due when reminders are on, not snoozed, something changed, and the last backup is a period old (or
// there has never been one and the data is at least a day old).
export function due(now = Date.now()) {
  const s = state(), days = REMIND[s.remind];
  if (days == null) return null;
  if (s.snooze_until && Date.parse(s.snooze_until) > now) return null;
  const changes = changesSince(s.last_backup_at);
  if (!changes) return null;
  const since = s.last_backup_at || store.one("profile")?.created_at;
  if (!since || now - Date.parse(since) < (s.last_backup_at ? days : 1) * DAY) return null;
  return { changes, last: s.last_backup_at };
}
export const snooze = (days = 3) => setState({ snooze_until: new Date(Date.now() + days * DAY).toISOString() });

export function nudgeHtml() {
  const d = due();
  if (!d) return "";
  const ago = d.last ? `Last backup ${Math.floor((Date.now() - Date.parse(d.last)) / DAY)} days ago, ${d.changes} change${d.changes === 1 ? "" : "s"} since.` : "No backup yet.";
  return `<div class="card nudge"><div class="nudge-text"><b>Your data lives only on this device.</b> ${esc(ago)} A backup is what saves it if the phone is lost or the browser clears it.</div>
    <div class="actions"><button class="primary small" data-backup="now">Back up now</button><button class="small" data-backup="later">Later</button></div></div>`;
}
export function bindNudge(root) {
  root.querySelector("[data-backup=now]")?.addEventListener("click", () => openExport());
  root.querySelector("[data-backup=later]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; if (button.dataset.saving === "true") return;
    button.dataset.saving = "true"; button.disabled = true;
    try { await commitAction(() => { snooze(3); toast("Reminding you in 3 days"); }); }
    catch {}
    finally { delete button.dataset.saving; if (button.isConnected) button.disabled = false; }
  });
}

// Temporary manual backups are sealed with the recovery words. No Hodos passphrase.
export function openExport() {
  if (session.mode !== "open") return toast("Set up and unlock your own encrypted records before exporting a backup.");
  const operationId = crypto.randomUUID(); let receipt = null, downloadedAt = null;
  modal({ title: "Export an encrypted backup", submitLabel: "Export",
    body: `<p>Keep this encrypted file on another device or in a drive you choose. Keep the words offline and separate from the file. Anyone with both can read the records.</p>${field("Your 12 recovery words", '<textarea name="bwords" rows="3" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>')}<p class="hint" data-export-result role="status"></p>`,
    onSubmit: async (f, form) => {
      if (receipt) await commitFormAction(form, operationId, null, receipt);
      else {
        if (!downloadedAt) {
          const words = String(f.get("bwords") || "").trim();
          const sealed = await vault.sealBackup(store.snapshot(), { words });
          if (!form.isConnected || session.mode !== "open") return false;
          form.elements.bwords.value = ""; form.elements.bwords.disabled = true;
          const blob = new Blob([JSON.stringify(sealed)], { type: "application/json" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `finance-backup-${today()}.json`; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          downloadedAt = nowIso();
          form.querySelector('[data-export-result]').textContent = "Backup download started. Retrying the save will not start another.";
        }
        // Export is available during a prior failure. Finish that same pending write before
        // capturing bookkeeping; if it still fails, retain the completed download for Retry.
        if (store.persistenceState().error) {
          const cancel = form.querySelector('[data-action="modal-cancel"]'), status = form.querySelector('[data-modal-status]');
          form.setAttribute("aria-busy", "true"); cancel.disabled = false; status.textContent = "Saving…";
          try { await store.retryPending(); }
          finally { form.setAttribute("aria-busy", "false"); cancel.disabled = false; status.textContent = ""; }
        }
        if (!form.isConnected || session.mode !== "open") return false;
        receipt = store.captureAction(operationId, () => setState({ last_backup_at: downloadedAt, snooze_until: null }));
        await commitFormAction(form, operationId, null, receipt);
      }
      if (!form.isConnected || session.mode !== "open") return false;
      if (receipt?.state !== "durable") throw new Error("Device storage did not confirm the backup record.");
      toast("Encrypted backup saved");
    } });
}
