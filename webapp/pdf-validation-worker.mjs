// Disposable parser thread: receives only bounded PDF bytes, never environment/key/app data.
import { parentPort, workerData } from "node:worker_threads";
import { validatePdf } from "./public/js/lib/assistant-pdf.js";
try { parentPort.postMessage({ ok: true, ...await validatePdf(new Uint8Array(workerData)) }); }
catch { parentPort.postMessage({ ok: false }); }
