// Read before the first paint, so a dark-mode user never gets a white flash on open. A file rather than
// an inline script, so the page's security rules can refuse every inline script.
try { var t = localStorage.getItem("pfa.theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
