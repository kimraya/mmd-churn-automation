# Nightingale Clients Export Service

Logs into Nightingale and exports the Clients table as a CSV
to a local folder. SharePoint upload is out of scope — a human
uploads the resulting `downloads/clients.csv` file manually.

## 1. Local setup

```bash
npm install
npx playwright install chromium   # downloads the browser Playwright drives
cp .env.example .env
```

Fill in `.env` with:
- Your Nightingale login (your own account for now — see go-live checklist below)
- A random `SERVICE_API_KEY` (generate one with `openssl rand -hex 32`) —
  only needed later if/when you deploy the server for n8n to call

## 2. Test locally before trusting it

Set `HEADLESS=false` in `.env`, then run:

```bash
npm run test-local
```

This exports the Clients CSV with the browser visible, so you can watch
exactly what happens. If a selector doesn't match Nightingale's actual page
(e.g. the login field or Export button behaves differently than expected),
adjust it in `lib/nightingale.js` — the comments there point to the specific
lines most likely to need a tweak.

Once that works reliably, run the batch locally — no server, no n8n, no
SharePoint step, just the overwritten `downloads/clients.csv` file for you to upload:

```bash
npm run export-batch
```

This is likely all you need for now. The server section below is only
relevant once/if you want n8n to trigger this automatically instead of
running it yourself.

## 3. Daily churn history and detection

Each run downloads a fresh Nightingale snapshot to a temporary file, then
compares it with the previous `downloads/clients.csv` using `InternalRecordNumber`.
Rows are written to `downloads/new-churns.csv` only when Service Exit Date or
Service Exit Reason changes from blank to populated. After comparison, the
fresh export replaces `downloads/clients.csv`.

The permanent dashboard source is `downloads/all-churns.csv`. It keeps one
row per Internal Record #, updates that row if its exit details change, and
does not duplicate records across daily runs. `new-churns.csv` is only the
latest daily delta; `all-churns.csv` is the historical list to eventually
send to SharePoint or use for dashboard refreshes.

If the snapshot and history files are deleted, the next run seeds the history
with all currently populated churn records and labels them with that run's
date. Keep `clients.csv` and `all-churns.csv` between daily runs. A record with
a new Internal Record # is treated as a separate service record.

---

Once that works reliably, set `HEADLESS=true` and start the server:

```bash
npm start
```

Then in a separate terminal:

```bash
curl -X POST http://localhost:3000/export-clients \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_SERVICE_API_KEY"
```

## 3. Deploying to your VM

- Provision a small VM (cheapest tier is enough — e.g. a $5–12/month droplet or similar).
- Install Node.js and Playwright's system dependencies (`npx playwright install-deps`).
- Copy this project over (or `git clone` a private repo — make sure `.env` is
  never committed, `.gitignore` already excludes it).
- Run `npm install --production` and `npx playwright install chromium` on the VM.
- Use a process manager so it survives reboots and restarts on crash, e.g.:
  ```bash
  npm install -g pm2
  pm2 start server.js --name nightingale-export
  pm2 save
  pm2 startup
  ```

### Put HTTPS in front of it — don't skip this

n8n Cloud will call this service over the public internet, and every request
carries either your Nightingale login or your Graph API secret in play. Do
**not** expose Express on port 3000 directly to the internet.

Put a reverse proxy in front of it that handles HTTPS — the simplest option
is [Caddy](https://caddyserver.com/), which auto-provisions a certificate:

```
# /etc/caddy/Caddyfile
your-subdomain.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Then lock down the VM's firewall to only allow inbound 443 (and 22 for your
own SSH access) — nothing should reach port 3000 directly from outside the
machine.

## 4. Configuring the n8n Cloud workflow

- **Trigger:** Schedule node, set to however often you want this to run.
- **HTTP Request node:**
  - Method: `POST`
  - URL: `https://your-subdomain.yourdomain.com/export-clients`
  - Headers: `x-api-key: YOUR_SERVICE_API_KEY`
- **After the request:** inspect `hasFailures`, `uploaded`, and
  `uploadFailures`. Branch to an alert node when either failures field is
  non-empty or `hasFailures` is `true`.

The server exports the Clients report and uploads the available CSV files to
SharePoint. The response's `downloadFolder` field identifies the local folder.

`N8N_WEBHOOK_URL` is optional. Leave it empty when the Schedule workflow is
calling `/export-clients`; otherwise the service will call that URL after a
successful upload. If you use it, create a separate n8n Webhook workflow so
the callback does not trigger the export workflow again.

## 5. Go-live checklist

Don't skip these before this touches real, ongoing production use:

- [ ] Create a **dedicated Nightingale service account** (not your personal
      System Administrator login) and switch `NG_EMAIL`/`NG_PASSWORD` to it
- [ ] **Rotate your personal Nightingale password**, since it was used during testing
- [ ] Confirm the VM firewall only exposes 443 (HTTPS), not 3000 directly
- [ ] Confirm `.env` is not committed anywhere, including in any deploy scripts
- [ ] Run one full real cycle, manually upload the resulting files to
      SharePoint, and confirm they flow through your existing downstream
      workflow correctly
- [ ] Set up basic monitoring — even just an alert if the VM or the
      `pm2` process goes down