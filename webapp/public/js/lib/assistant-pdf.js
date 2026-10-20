// Local PDF structure validation only. No text extraction, OCR, scripts or network.
import { PDFDocument } from "../../vendor/pdf-lib.esm.js";
import { LIMITS } from "./assistant-tasks.js";

export async function validatePdf(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > LIMITS.fileBytes) throw new Error("PDF exceeds the 5 MB limit or is empty.");
  let document;
  try { document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true }); }
  catch (error) {
    if (error.name === "EncryptedPDFError") throw new Error("This PDF is password-protected. Export an unlocked PDF before sending it.");
    throw new Error("This PDF could not be parsed safely. It may be damaged or use an unreadable format; export it again.");
  }
  const pages = document.getPageCount();
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error("This PDF has no readable pages.");
  if (pages > LIMITS.pdfPages) throw new Error("This PDF has more than 20 pages. Split it into smaller files.");
  return { pages };
}
