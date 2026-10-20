// This app's own server sits beside the page, so its address is worked out from the page rather than
// assumed to be the domain root. On a static host there is no server: the call fails and the app says so.
export const apiUrl = (p) => { const here = typeof location !== "undefined" && location.href ? location.href.split("#")[0] : "http://localhost/"; return new URL(p, here).href; };
