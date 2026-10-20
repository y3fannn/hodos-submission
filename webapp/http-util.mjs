// Small pieces every route needs: JSON replies, bounded bodies, cookies, where a request came from.

export function json(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}

// Photos are the largest thing sent. Anything past this is refused before it is read.
export const MAX_BODY = 12 * 1024 * 1024;
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let s = "", size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { req.destroy(); reject(new Error("too large")); } else s += c; });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
// Sign-in bodies are a few hundred bytes; a passkey answer is the largest, at a few kilobytes.
export async function readJson(req, limit = 64 * 1024) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw || "{}"); } catch { return null; }
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge = null, httpOnly = true, sameSite = "Strict", secure = false, path = "/" } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, httpOnly && "HttpOnly", `SameSite=${sameSite}`, secure && "Secure", maxAge != null && `Max-Age=${maxAge}`].filter(Boolean).join("; ");
}

export const isHttps = (req) => Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
// Behind a reverse proxy on the VM, the visitor's address arrives in a header. It is trusted only
// when the server is told a proxy is there; otherwise anyone could type one in.
export const clientIp = (req) => (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
