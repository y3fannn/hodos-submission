# Hodos presentation website

This is the separate presentation site, containing fictional screens and authored example conversations. It does not demonstrate real provider extraction or device saving.

From the repository root, using Node.js 24:

```sh
node landing-mockup/serve.mjs
```

Open http://localhost:4173/. No install or credentials are required. The website's product links point to the original Hodos app; change them if hosting your own version.

For a static production bundle, choose a new output directory outside the app and landing source folders:

```sh
node landing-mockup/package.mjs --landing ./hodos-landing
```

The bundle includes public assets and error pages; it excludes source tools, tests and internal evidence. Packaging does not publish it. See [deployment](deploy/README.md).

Existing browser checks use Chrome and disposable local fixtures:

```sh
node landing-mockup/test/browser.mjs
node landing-mockup/test/published.mjs
```

Set `CHROME` to your installed executable as described in the [app test guide](../webapp/README.md#tests). Image-authoring tools under [test](test/) use fictional records and can regenerate illustration assets; they are separate from app acceptance.
