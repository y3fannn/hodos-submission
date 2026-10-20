# Publish the static presentation site

From the source root, build into a new, nonexistent directory:

```sh
node landing-mockup/package.mjs --landing ./hodos-landing
```

Serve that directory on your static host over HTTPS. Keep it separate from the financial app. Configure real 404/503 handling if your host supports it; an unavailable server cannot deliver its own error page.

The supplied [Caddy example](Caddyfile.example) uses the original Hodos domain and `/var/www/hodos/current`. Adapt the hostname/root for your own host, validate the configuration and preserve other sites before reloading. The package's canonical URL, sitemap and product links also need your own addresses when rehosting.

[publish.sh](publish.sh) is the retained original tagged-release publisher. It assumes the original Linux folder layout, a clean Git checkout and matching release tags; this clean source snapshot supplies none of that Git history. Use it only after configuring that separate environment. Ordinary static hosting needs only the generated bundle.

After publishing, check the homepage, a missing path, the 503 page, mobile scrolling and product links at the public URL. This source preparation does not publish or verify a live server.
