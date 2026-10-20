# Hodos — source submission

Hodos is a personal-finance prototype for recording money, reviewing spending and asking questions about saved records.

This is a clean snapshot of source commit `226df907c8619ee81a12f864fa4d4406b095e257`.
The [submission repository](https://github.com/y3fannn/hodos-submission) is public; judges can view and download it without an invitation. The [original repository](https://github.com/lyd-sg/personal-finance-ai-agent) remains separate and private. This folder and its ZIP contain the source directly, without the original Git history.

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

## Current Scope and Limitations portion replace with

Hodos is a single-device personal finance application combining financial management tools with AI-assisted interactions. Its integrated design provides a foundation for more connected financial insights as the application evolves.

- AI Assistant: Supports questions about spending, transactions, and accounts, alongside AI-assisted record creation. AI-generated suggestions should be reviewed before saving.
- Financial Insights: Provides financial information and analysis within the currently supported features. More advanced synthesis across financial modules is a potential future enhancement.
- Data Import: Supports importing one file at a time.
- Device Support: Currently supports single-device use.
- Demo Content: Website screenshots and sample conversations use fictional financial data for demonstration purposes.

This preparation changes packaging and documentation only. It does not repair those limitations, establish full security acceptance or deploy the app.
