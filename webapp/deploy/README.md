# Deploy your own instance

These files describe a Linux host running Node.js 24 behind Caddy. They are examples, not access to the original server. Use your own domain, account credentials and server. No deployment is performed by this source package.

## Initial setup

Install Node.js 24, npm and Caddy using your host's normal administration process. Create a dedicated `finagent` service account. Place this source at `/opt/finagent/app`; the supplied service expects Node at `/usr/bin/node`.

As the administrator:

```sh
sudo install -d -o finagent -g finagent -m 0750 /var/lib/finagent
sudo install -d -o root -g root -m 0700 /etc/finagent
sudo install -o root -g root -m 0600 /opt/finagent/app/webapp/deploy/finagent.env.example /etc/finagent/env
sudoedit /etc/finagent/env
```

Replace the example Hodos domain in `APP_ORIGIN`, `RP_ID` and `EMAIL_FROM` with your own. Choose the passkey domain before creating accounts; changing it can break existing credentials. Keep `HOST=127.0.0.1`, `NODE_ENV=production`, `DATA_DIR=/var/lib/finagent` and authentication enabled.

Add your provider credentials only to this protected environment file. Email is off by default; production email needs `EMAIL_MODE=resend`, a sending key and verified sender. Google is optional. Production refuses local email-code logging.

Install locked dependencies and the service:

```sh
sudo -u finagent npm --prefix /opt/finagent/app/webapp ci --omit=dev
sudo install -o root -g root -m 0644 /opt/finagent/app/webapp/deploy/finagent.service /etc/systemd/system/finagent.service
sudo systemctl daemon-reload
sudo systemctl enable --now finagent
```

Ensure the service account can read the source and installed dependencies. Adapt `ExecStart` if Node is elsewhere.

Merge [Caddyfile.example](Caddyfile.example) into your own Caddy configuration, replacing the domain. Preserve other sites. Point your domain's DNS at your host and permit HTTPS/HTTP ports 443/80 through the host and cloud firewalls. Validate the candidate configuration before reloading Caddy:

```sh
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS http://127.0.0.1:8787/api/auth/status
```

Then check your public HTTPS address, email/Google configuration if enabled, physical-device passkey setup and return, and reviewed financial saves after reload. A health response is not proof those journeys work. Back up the account database using a consistent SQLite backup procedure; financial records live separately in users' encrypted browser storage.

## Updates and existing helpers

Keep a recoverable copy of the prior source and account database. Stop the service before replacing source, install locked dependencies, restart and verify health and the public app. If a change fails, restore the previous source and matching dependencies; preserve user/account data.

[deploy.sh](deploy.sh), the deployment service/timer and sudoers example are retained from the original project. They require a separately configured Git remote, tested `deploy-*` tags and the expected Linux paths. This clean snapshot has no original Git history, remote or release tags. Do not run that helper against an existing working checkout as a general install command: it switches source versions. The timer should remain disabled unless deliberately configured by the host owner.

The [landing website](../../landing-mockup/deploy/README.md) is a separate static deployment.
