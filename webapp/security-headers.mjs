// Browser rules sent with every response. Kept apart from the server so the tests can read them, and
// mirrored as a <meta> tag in index.html for static hosts that cannot send headers.
// Scripts only from this server, never inline; the browser talks to this server and nothing else.
// Styles allow inline style attributes, which the app uses for bar widths and chart positions: a style
// cannot run code, and scripts, where the danger is, stay strict.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
  "frame-ancestors 'none'", "manifest-src 'self'", "worker-src 'self'",
].join("; ");
export const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};
// Only meaningful over HTTPS; a browser ignores it on plain HTTP, and localhost is plain HTTP.
export const HSTS = "max-age=31536000; includeSubDomains";
