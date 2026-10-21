# Nightingale Clients Export Service

Logs into Nightingale, reads the Clients table, and keeps one output file:
`downloads/all-churns.csv` (every client with an exit date or reason). It is
uploaded to SharePoint, which triggers the n8n workflow.

## macOS quick start

Step-by-step for running the export on a Mac. SharePoint and n8n are optional:
if their settings are blank, the files are just saved locally in `downloads/`.

### Step 1: Install Node.js

1. Open **Terminal** (Cmd+Space, type "Terminal", press Enter).
2. Run `node -v`. If it prints `v18` or higher, skip to Step 2.
3. Otherwise install Node: `brew install node`, or download the **LTS**
   installer from https://nodejs.org.
4. Close and reopen Terminal, then run `node -v` again to confirm.

### Step 2: Go to the project folder

```bash
cd /Users/kim/Documents/MMD/mmd-churn-automation
```

### Step 3: Install dependencies

```bash
npm install
npx playwright install chromium
```

The second command downloads the browser the script drives (about 150 MB, one-off).

### Step 4: Create your settings file

```bash
cp .env.example .env
open -e .env
```

Change only these lines (no quotes around values), then save:

```
NG_BASE_URL=https://nightingale-maidmyday.azurewebsites.net
NG_EMAIL=your real Nightingale email
NG_PASSWORD=your real Nightingale password
HEADLESS=false
```

Leave the `MS_...` and `SHAREPOINT_...` lines alone (or delete them) so the
SharePoint upload is skipped. `.env` is git-ignored and never committed.

### Step 5: First run, with the browser visible

```bash
npm run export-batch
```

A Chromium window opens, logs in, loads the Clients page and closes (about a
minute). Don't click in it. When it finishes you should see:

```
  [CHURNS] <n> total in history.
✓ clients: all-churns.csv
1/1 report exported successfully.
SharePoint not configured yet ... skipping upload.
```

(`npm run test-local`, mentioned further down, does not exist. Use `export-batch`.)

### Step 6: Check the results

```bash
open downloads
```

`all-churns.csv` is the only output: every client with an exit date or
reason, plus a `DetectedDate` column (the date of the run that first saw them).
On the very first run it lists every existing churn, all marked with today's
date. That is expected.

### Step 7: Run it again each day

Run `npm run export-batch` whenever you want a fresh export.

- Keep `all-churns.csv` between runs: it is the history. Deleting it restarts
  the history.
- Close `all-churns.csv` in Excel first. If it is locked, the run fails
  (exit code 1) and nothing is uploaded.

### Step 8 (optional): Run without the browser window

Once Step 5 works, set `HEADLESS=true` in `.env`.

### Troubleshooting

| Problem | What to do |
|---|---|
| `command not found: npm` | Node isn't installed. Redo Step 1 and reopen Terminal. |
| "Executable doesn't exist" (Playwright) | Run `npx playwright install chromium` again. |
| Login timeout or selector error | Keep `HEADLESS=false` and watch where it stops. A screenshot is saved in `debug/`. Adjust selectors in `lib/nightingale.js`. |
| "Could not capture the Clients grid request" | The Clients page didn't fully load. Re-run, and confirm you can open it in a normal browser. |
| Login rejected | Check `.env`, and log in manually once to confirm the account works. |

> Don't fill in the SharePoint settings yet: a same-day re-run can append
> duplicate rows to the Excel churn table through the n8n workflow.

---

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

Each run reads a fresh Nightingale snapshot from a temporary file (deleted
afterwards) and merges every client that has a Service Exit Date or Reason into
`downloads/all-churns.csv`. It keeps one row per Internal Record #, updates that
row if its exit details change, and never duplicates records across runs. The
n8n workflow upserts these rows into the Churn / Orders Taken Back tabs.

If `all-churns.csv` is deleted, the next run seeds the history with all
currently populated churn records and labels them with that run's date. A
record with a new Internal Record # is treated as a separate service record.

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