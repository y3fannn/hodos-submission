import { validatePdf } from "../lib/assistant-pdf.js";

self.onmessage = async ({ data }) => {
  try {
    const result = await validatePdf(new Uint8Array(data.bytes));
    self.postMessage({ ok: true, ...result });
  } catch (error) {
    self.postMessage({ ok: false, message: error?.message || "PDF validation is unavailable; this PDF was not sent." });
  }
};
