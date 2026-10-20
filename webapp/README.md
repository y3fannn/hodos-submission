# Run and test Hodos

Requires Node.js 24 and npm. In this directory:

```sh
npm ci
npm start
```

Open http://localhost:8787/. For a quick sample-only tour, open http://localhost:8787/#/demo while signed out. Windows PowerShell users can use `npm.cmd` instead of `npm`.

## Optional configuration

Copy [.env.example](.env.example) to `.env`. Leave credentials blank for manual/demo use. AI requires your own `ANTHROPIC_API_KEY`, consent, sign-in and enrolled-device approval. Model identifiers are pinned in source; provider availability must be checked with your account.

Local email-code sign-in prints codes in the server terminal. Passkey setup needs a browser/authenticator supporting encryption through WebAuthn PRF; use `localhost`, not a bare IP. Demo mode needs no passkey. Google sign-in requires your own client ID, secret and callback URL `<APP_ORIGIN>/api/auth/google/callback`.

| Setting | Purpose |
|---|---|
| `HOST`, `PORT` | Listening interface and port; use `HOST=127.0.0.1` to restrict access to this computer |
| `APP_ORIGIN` | Allowed browser addresses, comma separated |
| `RP_ID` | Passkey domain; choose before enrollment and keep stable |
| `DATA_DIR` | Account database directory; defaults to `webapp/data` |
| `EMAIL_MODE` | `log` for local development, `off`, or `resend` |
| `RESEND_API_KEY`, `EMAIL_FROM` | Your sending key and verified sender |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional Google sign-in credentials |
| `AI_HOURLY_LIMIT` | Per-person request limit, default 30 |
| `TRUST_PROXY` | Set to 1 only behind the configured reverse proxy |

Keep authentication enabled on shared servers. Never commit `.env`, account databases, keys or user exports.

## Tests

Run these existing checks from this directory; they use disposable data and no paid AI:

```sh
node test/persistence.mjs
node test/smoke.mjs
node test/assistant-mvp-accuracy.mjs
node test/assistant-mvp-scope.mjs
node test/assistant-privacy.mjs
node test/server-auth.mjs
node test/assistant-proxy.mjs
```

Browser tests need an installed Chrome executable. Set `CHROME` to its full path. In PowerShell, for example:

```powershell
$env:CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node test/assistant-mvp-import.mjs
node test/browser-import-cancel.mjs
node test/browser-save-safety.mjs
```

On macOS/Linux use `export CHROME="/path/to/chrome"` first. Keep Chrome's sandbox enabled on ordinary computers.

The retained `browser-save-safety.mjs` check has a recorded chat-resume failure; do not treat all tests as passing. Older `assistant-additions`, `assistant-composer`, `assistant-journey` and bill-date tests include superseded broader chat expectations. See the [submission limitations](../README.md#known-limitations-of-this-snapshot).

This preparation also found a Windows path error in `smoke.mjs` and a sample-data baseline mismatch that stops `server-auth.mjs`. See the [check results](../README.md#submission-preparation-checks); the supplied tests have not been weakened or rewritten.

## Source layout

| Path | Purpose |
|---|---|
| [server.js](server.js) | HTTP server and AI proxy |
| [auth.mjs](auth.mjs), [accounts.mjs](accounts.mjs), [email.mjs](email.mjs) | Identity, account database and email |
| [public/js/lib](public/js/lib/) | Money calculations, encrypted storage, AI validation and shared UI |
| [public/js/features](public/js/features/) | Feature screens and operations |
| [test](test/) | Existing checks and local fixtures |
| [deploy](deploy/) | Linux service and deployment examples |

Google's button artwork is stored locally from its [branding assets](https://developers.google.com/identity/branding-guidelines). The label font's [OFL licence](public/google-sans-OFL.txt) and the bundled [PDF-library licence](public/vendor/pdf-lib.LICENSE.md) are retained.
