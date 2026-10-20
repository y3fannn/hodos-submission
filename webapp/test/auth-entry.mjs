// Deterministic entry-page, method URL and icon checks; no browser, credentials or real mail.
import assert from "node:assert/strict";
import fs from "node:fs";
import { inflateSync } from "node:zlib";
import { signinPage } from "../public/js/features/signin.js";
import * as account from "../public/js/lib/account.js";
import { session } from "../public/js/lib/session.js";

let checks = 0;
const ok = (condition, name) => { assert.ok(condition, name); checks++; };
const publicFile = (name) => new URL("../public/" + name, import.meta.url);
const savedState = { ...account.state }, savedMode = session.mode;
const credentialDescriptor = Object.getOwnPropertyDescriptor(navigator, "credentials");
const publicKeyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "PublicKeyCredential");
try {
  Object.assign(account.state, { server: true, enabled: true, signedIn: false, google: true, email: "resend" });
  session.mode = "setup";
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { create() {} } });
  Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: class {} });
  const signin = signinPage({ firstRun: true });
  ok(signin.title === "Sign in" && signin.html.includes("<h1>Sign in</h1>"), "default entry is a separate Sign in page");
  ok(signin.html.includes('href="#/signup"') && signin.html.includes("Try it out first"), "Sign in has signup and demo entries");
  ok(signin.html.includes('data-action="passkey"') && signin.html.includes('data-form="recovery"'), "Sign in retains passkey/recovery");
  ok(signin.html.includes("google-g.png") && signin.html.includes('aria-hidden="true"'), "Google branding is local and decorative beside its label");
  ok(signin.html.includes('src="icon.svg?v=hvault1"'), "Sign in uses the selected H-vault mark");
  ok(!signin.html.includes("first sign-in creates") && !signin.html.includes("Track every dollar") && !signin.html.includes("[object Object]"), "no implicit-registration copy, marketing hero or broken rendering");
  const signup = signinPage({ firstRun: true, intent: "signup" });
  ok(signup.title === "Create account" && signup.html.includes("<h1>Create an account</h1>"), "signup has its own title and heading");
  ok(signup.html.includes('href="#/signin"') && signup.html.includes("Try it out first"), "signup has Sign in and demo entries");
  ok(signup.html.includes("google-g.png") && signup.html.includes('data-form="email"'), "signup offers Google and verified email");
  ok(!signup.html.includes('data-action="passkey"') && !signup.html.includes('data-form="recovery"'), "passkey/recovery do not pretend to create an account");
  const googleHref = signup.html.match(/data-action="google" href="([^"]+)"/)[1].replace(/&amp;/g, "&");
  ok(new URL(googleHref).searchParams.get("intent") === "signup", "signup Google link carries signup purpose");
  ok(new URL(account.googleUrl(false)).searchParams.get("remember") === "0" && new URL(account.googleUrl(false)).searchParams.get("intent") === "signin", "Google defaults to Sign in and respects remember choice");
  const injected = signinPage({ query: "error=%3Cimg%20src=x%20onerror=alert(1)%3E" });
  ok(!injected.html.includes("onerror="), "query-string errors cannot inject markup");
  const missing = signinPage({ query: "error=account_missing" });
  ok(missing.html.includes("no Hodos account yet"), "first-run Google missing-account error offers signup");
  Object.assign(account.state, { signedIn: true, account: { email: '<img src=x onerror="bad">' } });
  const signed = signinPage();
  ok(signed.html.includes("&lt;img") && !signed.html.includes('<img src=x'), "signed-in address is escaped");
  ok(!signed.html.includes('data-action="demo"') && !signinPage({ intent: "signup" }).html.includes('data-action="demo"'), "neither authenticated entry offers demo");
  Object.assign(account.state, { signedIn: false, server: false });
  ok(signinPage({ intent: "signup" }).html.includes("Accounts are off here"), "static/offline copies do not pretend registration works");
} finally {
  Object.assign(account.state, savedState); session.mode = savedMode;
  if (credentialDescriptor) Object.defineProperty(navigator, "credentials", credentialDescriptor); else delete navigator.credentials;
  if (publicKeyDescriptor) Object.defineProperty(globalThis, "PublicKeyCredential", publicKeyDescriptor); else delete globalThis.PublicKeyCredential;
}

// Both SVGs use the same selected rectangle geometry, never font/emoji/dollar artwork.
const svg = fs.readFileSync(publicFile("icon.svg"), "utf8"), mask = fs.readFileSync(publicFile("icon-maskable.svg"), "utf8");
ok(!svg.includes("<text") && !mask.includes("<text") && !svg.includes("$"), "H-vault mark has no dollar glyph or font dependency");
ok(svg.match(/<g[\s\S]*<\/g>/)[0] === mask.match(/<g[\s\S]*<\/g>/)[0], "tab and maskable glyphs are identical");
ok(!mask.includes('rx="112"') && mask.includes('fill="#070c20"'), "maskable background is dark and full-bleed");
for (const rect of mask.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)) {
  const [x, y, w, h] = rect.slice(1).map(Number);
  ok([[x,y],[x+w,y],[x,y+h],[x+w,y+h]].every(([a,b]) => Math.hypot(15.36 + .94*a - 256, 15.36 + .94*b - 256) <= 204.8), "H geometry stays inside maskable safe circle");
}
const manifest = JSON.parse(fs.readFileSync(publicFile("manifest.webmanifest"), "utf8"));
ok(manifest.icons.length === 4 && manifest.icons.every(i => i.src.endsWith("?v=hvault1") && fs.existsSync(publicFile(i.src.split("?")[0]))), "all installed icon URLs are versioned and exist");
ok(fs.readFileSync(publicFile("index.html"), "utf8").includes('apple-touch-icon.png?v=hvault1'), "iOS icon is versioned too");
ok(fs.readFileSync(publicFile("google-sans-OFL.txt"), "utf8").includes("SIL OPEN FONT LICENSE"), "local Google font retains its licence");
ok(fs.statSync(publicFile("google-sans-500.ttf")).size < 20000, "Google label font is a small local subset");

// Decode Chrome's truecolour PNGs to catch stale dollar images, not just filenames/dimensions.
function pixels(name, size) {
  const png = fs.readFileSync(publicFile(name));
  assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  const bpp = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
  assert.ok(bpp && png[24] === 8 && png[28] === 0, "8-bit non-interlaced truecolour PNG");
  const chunks = [];
  for (let p = 8; p < png.length;) {
    const n = png.readUInt32BE(p);
    if (png.toString("ascii", p + 4, p + 8) === "IDAT") chunks.push(png.subarray(p + 8, p + 8 + n));
    p += n + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = size*bpp, image = Buffer.alloc(size*stride);
  const paeth = (a,b,c) => { const p = a+b-c, da = Math.abs(p-a), db = Math.abs(p-b), dc = Math.abs(p-c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < size; y++) {
    const filter = raw[y*(stride+1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const p = y*stride+x, a = x >= bpp ? image[p-bpp] : 0, b = y ? image[p-stride] : 0, c = y && x >= bpp ? image[p-stride-bpp] : 0;
      const predict = [0, a, b, Math.floor((a+b)/2), paeth(a,b,c)][filter];
      image[p] = (raw[y*(stride+1)+x+1] + predict) & 255;
    }
  }
  return (x,y) => image.subarray((y*size+x)*bpp, (y*size+x)*bpp+3).toString("hex");
}
for (const [name, size] of [["icon-192.png",192],["icon-512.png",512],["apple-touch-icon.png",180]]) {
  const pixel = pixels(name, size);
  ok(pixel(0,0) === "070c20" && pixel(size/2,size/2) === "bfa063", name + ": H-vault background and gold crossbar, not a stale dollar");
}
console.log(`${checks} entry/icon checks passed`);
