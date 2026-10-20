// Bounded, local preparation for Assistant uploads. This module never saves records.
import { LIMITS, validateOutput } from "../lib/assistant-tasks.js";
import * as T from "./transactions.js";
import * as A from "./accounts.js";

const formats = new Map([
  ["jpg", { kind: "image", media: "image/jpeg" }], ["jpeg", { kind: "image", media: "image/jpeg" }],
  ["png", { kind: "image", media: "image/png" }], ["webp", { kind: "image", media: "image/webp" }],
  ["pdf", { kind: "pdf", media: "application/pdf" }], ["csv", { kind: "csv" }],
  ["md", { kind: "text" }], ["txt", { kind: "text" }],
]);
const abortIfNeeded = signal => { if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError"); };
const extOf = file => String(file?.name || "").split(".").at(-1).toLowerCase();
const bytes = async (file, signal) => { abortIfNeeded(signal); const b = new Uint8Array(await file.arrayBuffer()); abortIfNeeded(signal); return b; };
const ascii = (b, start, end) => String.fromCharCode(...b.slice(start, end));
function contentMatches(ext, b) {
  if (ext === "jpg" || ext === "jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "png") return b.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => b[i] === v);
  if (ext === "webp") return b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP";
  if (ext === "pdf") return b.length >= 8 && ascii(b, 0, 5) === "%PDF-";
  return true;
}
function decodeText(b) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { throw new Error("This text file is unreadable as UTF-8. Export it as plain UTF-8 text or CSV."); }
}
function csvRows(text) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("This file contains non-text control bytes and is not readable as CSV or plain text.");
  const rows = T.parseCsv(text);
  if (!rows.length) throw new Error("This CSV has no readable header or data rows.");
  const count = rows.length - 1;
  if (count > LIMITS.csvRows) throw new Error(`This CSV has ${count} data rows; the limit is ${LIMITS.csvRows}. Export or split it into smaller files.`);
  return rows;
}
function asData(b) { let binary = ""; for (let i = 0; i < b.length; i += 0x8000) binary += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(binary); }

export async function validatePdf(input, { signal, timeoutMs = 5000 } = {}) {
  abortIfNeeded(signal);
  if (typeof Worker !== "function") throw new Error("PDF validation is unavailable in this browser; no PDF was sent.");
  const worker = new Worker(new URL("./assistant-pdf-worker.js", import.meta.url), { type: "module" });
  const buffer = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  try {
    return await new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate(); fn(value); };
      const timer = setTimeout(() => finish(reject, new Error("PDF validation took too long; the file was not sent.")), timeoutMs);
      const abort = () => finish(reject, new DOMException("Operation cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => data.ok ? finish(resolve, data) : finish(reject, new Error(data.message));
      worker.onerror = () => finish(reject, new Error("This PDF could not be read safely; it was not sent."));
      worker.postMessage({ bytes: buffer }, [buffer]);
    });
  } finally { worker.terminate(); }
}

/**
 * Prepare files as reviewable drafts. callAI(task, options) is an injected, non-writing provider seam.
 * onDraft receives extracted proposals / CSV mapping+parsed rows; the parent owns all normal review and saves.
 * A bounded PDF worker checks structure/encryption/pages before native PDF submission; no OCR or conversion.
 */
export async function prepareFiles(files, { signal, callAI, onDraft, onDisclosure, accountId, work, message, today, timezone, description, context, setup, imageReader, nativeCsv = false } = {}) {
  const selected = Array.from(files || []);
  if (selected.length > 1) throw new Error("Choose one file at a time.");
  const total = selected.reduce((n, f) => n + (Number(f.size) || 0), 0);
  if (total > LIMITS.batchBytes) throw new Error(`These files total more than ${LIMITS.batchBytes / 1024 / 1024} MB. Split them into smaller batches.`);
  const results = [];
  for (const file of selected) {
    abortIfNeeded(signal);
    const ext = extOf(file), spec = formats.get(ext);
    const state = { name: String(file.name || "file"), status: "error", drafts: [] };
    results.push(state);
    try {
      if (!spec) throw new Error("This file type is not supported. Use JPEG, PNG, WebP, PDF, CSV, MD or TXT; export Word documents as PDF and spreadsheets as CSV.");
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.fileBytes) throw new Error(`This file is larger than the ${LIMITS.fileBytes / 1024 / 1024} MB per-file limit.`);
      const b = await bytes(file, signal);
      if (b.length !== file.size) throw new Error("The file could not be read completely.");
      if (!contentMatches(ext, b)) throw new Error("The file contents do not match its filename, or the file is damaged.");
      if (spec.kind === "pdf") {
        const check = await validatePdf(b, { signal });
        if (check.pages > 20) throw new Error("This PDF has more than 20 pages. Split it into smaller files; it was not sent.");
        if (typeof callAI !== "function") throw new Error("Assistant file extraction is not connected.");
        state.disclosure = "This PDF is sent as provided and is not automatically anonymised.";
        await onDisclosure?.({ file, message: state.disclosure }); abortIfNeeded(signal);
        const output = await callAI("assistant_extract", { documents: [{ media_type: "application/pdf", data: asData(b) }], input: { message, today, timezone, description, context, setup, file_kind: "pdf" }, signal });
        abortIfNeeded(signal);
        const invalid = validateOutput("assistant_extract", output);
        if (invalid || !output.complete) throw new Error("PDF extraction was incomplete or invalid; no result was marked complete.");
        state.status = output.actions.length ? "ready" : "clarification"; state.drafts = output.actions; state.text = output.text || null;
        await onDraft?.({ kind: "extraction", file, actions: output.actions, text: output.text || null, complete: true, accountId });
        continue;
      } else if (spec.kind === "image") {
        if (typeof callAI !== "function") throw new Error("Assistant file extraction is not connected.");
        const bitmap = await createImageBitmap(file);
        try { if (!bitmap.width || !bitmap.height) throw new Error("This image has no readable pixels."); } finally { bitmap.close(); }
        state.disclosure = "The image is sent as provided and is not automatically anonymised.";
        await onDisclosure?.({ file, message: state.disclosure }); abortIfNeeded(signal);
        if (imageReader) {
          state.photo = await imageReader(file, signal); abortIfNeeded(signal); state.status = "ready";
          await onDraft?.({ kind: "image", file, photo: state.photo, accountId }); continue;
        }
        const output = await callAI("assistant_extract", { images: [{ media_type: spec.media, data: asData(b) }], input: { message, today, timezone, description, context, setup, file_kind: "image" }, signal });
        abortIfNeeded(signal);
        const invalid = validateOutput("assistant_extract", output);
        if (invalid) throw new Error(`The extraction response was incomplete or invalid (${invalid}); no result was marked complete.`);
        if (!output.complete) throw new Error("The extraction is incomplete. No partial result is presented as complete.");
        state.status = output.actions.length ? "ready" : "clarification"; state.drafts = output.actions; state.text = output.text || null;
        await onDraft?.({ kind: "extraction", file, actions: output.actions, text: output.text || null, complete: true, accountId });
      } else {
        const text = decodeText(b);
        if (text.length > LIMITS.text) throw new Error(`This file has more than ${LIMITS.text} characters. Split or shorten it; nothing was truncated.`);
        if (spec.kind === "text") {
          if (typeof callAI !== "function") throw new Error("Assistant file extraction is not connected.");
          state.disclosure = "The document text is sent as provided and is not automatically anonymised.";
          await onDisclosure?.({ file, message: state.disclosure }); abortIfNeeded(signal);
          const output = await callAI("assistant_extract", { input: { message, text, today, timezone, description, context, setup, file_kind: "text" }, signal });
          abortIfNeeded(signal);
          const invalid = validateOutput("assistant_extract", output);
          if (invalid) throw new Error(`The extraction response was incomplete or invalid (${invalid}); no result was marked complete.`);
          if (!output.complete) throw new Error("The extraction is incomplete. No partial result is presented as complete.");
          state.status = output.actions.length ? "ready" : "clarification"; state.drafts = output.actions; state.text = output.text || null;
          await onDraft?.({ kind: "extraction", file, actions: output.actions, text: output.text || null, complete: true, accountId });
        } else {
          csvRows(text);
          if (!nativeCsv && typeof callAI !== "function") throw new Error("CSV column mapping needs the Assistant mapping callback.");
          const account = accountId ? A.get(accountId) : null;
          if (!account) { state.status = "waiting"; state.message = "Choose or create an account to continue this CSV import; the file is waiting in setup."; state.file = file; continue; }
          if (typeof callAI === "function") {
            state.disclosure = "CSV headers and sample rows are sent as provided for column mapping; they are not automatically anonymised.";
            await onDisclosure?.({ file, message: state.disclosure }); abortIfNeeded(signal);
          }
          // The owning import flow does parsing, mapping validation, manual fallback, and normal review.
          if (!work || typeof work.operation?.progress !== "function" || typeof work.check !== "function" || typeof work.commit !== "function" || typeof work.active !== "function") {
            state.status = "waiting"; state.message = "CSV import is waiting for the app's active import-work connection; no mapping was requested."; state.file = file; continue;
          }
          const review = await T.reviewCsvImport(file, accountId, work, { suggestCategories: nativeCsv, mapColumns: typeof callAI === "function" ? async (headers, samples) => {
            const mapping = await callAI("assistant_csv_map", { input: { header: headers, sample_rows: samples.slice(0, 5), message }, signal });
            abortIfNeeded(signal);
            const invalid = validateOutput("assistant_csv_map", mapping);
            if (invalid) throw new Error(`CSV column mapping was invalid (${invalid}); nothing was imported.`);
            return mapping;
          } : null });
          state.status = "ready"; state.review = review;
          await onDraft?.({ kind: "csv", file, review, accountId });
        }
      }
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
      state.message = error?.message || "This file could not be read.";
    }
  }
  return results;
}
