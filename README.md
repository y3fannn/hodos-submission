# Hodos — source submission

Hodos is a personal-finance prototype for recording money, reviewing spending and asking questions about saved records.

This is a clean snapshot of source commit `226df907c8619ee81a12f864fa4d4406b095e257`.
The [submission repository](https://github.com/y3fannn/hodos-submission) is private; judges need access to that repository. The [original repository](https://github.com/lyd-sg/personal-finance-ai-agent) remains separate. This folder and its ZIP contain the source directly, without the original Git history.

## Run locally

Use Node.js 24 and npm. From this folder:

```sh
cd webapp
npm ci
npm start
```

Open **http://localhost:8787/#/demo** for fictional sample data. On Windows PowerShell, use `npm.cmd` if local policy blocks `npm.ps1`. No build step is needed.

AI needs a server-side provider key and an approved signed-in device. No credentials or user records are supplied. See [app setup and tests](webapp/README.md), [server deployment](webapp/deploy/README.md) and [presentation website](landing-mockup/README.md).

## What is included

- App and server source, dependency lockfile, blank configuration examples and existing tests.
- Separate presentation website, its fictional illustrations, packaging tools and deployment examples.
- Bundled [PDF-library licence](webapp/public/vendor/pdf-lib.LICENSE.md) and [font licence](webapp/public/google-sans-OFL.txt). Dependency licences are included when npm installs the locked packages.
- [Source manifest](SOURCE.json), identifying the source version and unchanged files.

Internal planning, agent instructions, historical decisions, screenshots used as development evidence, Git history, installed dependencies, credentials and account databases are excluded. Original automatic publication workflows are excluded; this copy does not configure GitHub Pages or release-tag automation.

## Data and permissions

Financial records are encrypted in the user's browser. The server handles account identity, device approval and AI requests; it does not store a readable financial ledger. AI receives the user-supplied material and permitted context needed for a request. App-generated identifying labels are replaced locally before sending; text the user writes or uploads may contain personal information.

Code calculates financial figures. AI proposes text or import drafts. Saving financial changes requires the normal review and confirmation; documented recurring entries are the exception. Consent, sign-in and enrolled-device checks control AI access. The server uses a request-rate limit; provider spending controls remain separate.

## Known limitations of this snapshot

- The recorded chat-save recovery bug remains: after a chat-message save fails, the expected resume control is missing. Global storage Retry exists, but continuation without duplicates has not passed acceptance. The existing save-safety test is retained.
- Assistant supports spending, transaction and account questions. Accounts and Records provide manual creation/correction; Add handles one imported file at a time. Some retained older Assistant tests expect broader flows and are not acceptance tests for this smaller scope.
- Actual Claude/PDF extraction accuracy, physical-device passkeys/accessibility and final database/simultaneous-device sync acceptance are not established by this package.
- Briefing, Deep Dive and chart-point inspection remain paused; debt calendar payoff dates remain hidden. Existing monthly estimates and manual features are retained.
- Website screenshots and conversations illustrate fictional data; they are not evidence of successful live AI extraction or saving.

This preparation changes packaging and documentation only. It does not repair those limitations, establish full security acceptance or deploy the app.

## Submission preparation checks

Checked on Windows with Node.js 24.13.1:

- Fresh `npm ci` installed all 35 locked packages in a separate disposable copy. The server started; its homepage and authentication-status endpoint returned HTTP 200 with fake credentials and temporary account storage.
- Persistence, Assistant MVP accuracy, Assistant MVP scope and Assistant privacy checks passed.
- Static landing packaging passed. All 217 retained non-document files match the source byte for byte. The 26 local README links resolve. No excluded private-data paths or common secret-key signatures were found; this is not a full security audit.
- `smoke.mjs` did not finish: its file-URL path handling produces an invalid Windows path during source inspection.
- `server-auth.mjs` passed its device-access, email and entry checks, then stopped in `demo-loading.mjs` because generated sample data did not match the stored baseline hash. The reason for that mismatch is not established; subsequent server-auth checks did not run.

The known chat-save recovery failure remains separately recorded above. Full browser, actual-provider and physical-device acceptance were not rerun during packaging.
