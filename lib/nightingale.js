const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { processChurnHistory } = require('./churnDetection');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');

/**
 * Run once with HEADLESS=false before relying on this in production so any
 * selector mismatch is visible and easy to diagnose.
 */

async function loginToNightingale(page) {
  const baseUrl = process.env.NG_BASE_URL;
  await page.goto(`${baseUrl}/Auth/Login`);

  await page.getByPlaceholder(/email/i).fill(process.env.NG_EMAIL);
  await page.getByPlaceholder(/password/i).fill(process.env.NG_PASSWORD);
  await page.getByRole('button', { name: /log ?in|sign ?in/i }).click();

  // Wait for something on a post-login page to confirm we're through.
  // Adjust this if your dashboard URL/heading looks different.
  await page.waitForURL(/Secure|Overview|Dashboard/i, { timeout: 20000 });
}

async function exportClients(page, downloadDir) {
  let listRequestData;
  const captureListRequest = (request) => {
    if (request.url().endsWith('/Secure/MVC/Clients/list') && request.method() === 'POST') {
      listRequestData = request.postData();
    }
  };
  page.on('request', captureListRequest);
  await page.goto(`${process.env.NG_BASE_URL}/Secure/MVC/Clients`, { waitUntil: 'networkidle' });
  await page.getByText('Export CSV', { exact: true }).waitFor({ state: 'visible' });

  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
  if (!listRequestData) throw new Error('Could not capture the Clients grid request.');

  // Nightingale persists the grid's last-used filters server-side per account,
  // so the captured request can carry over whatever search/filter someone left
  // active (e.g. a name search used for manual testing). Strip all search
  // values so the export always pulls the full, unfiltered client list.
  const baseParams = new URLSearchParams(listRequestData);
  if (baseParams.has('search[value]')) baseParams.set('search[value]', '');
  for (const key of [...baseParams.keys()]) {
    if (/^columns\[\d+\]\[search\]\[value\]$/.test(key)) baseParams.set(key, '');
  }
  listRequestData = baseParams.toString();

  const gridRows = await page.evaluate(async (postData) => {
    const rows = [];
    const pageSize = 100;
    for (let start = 0; ; start += pageSize) {
      const params = new URLSearchParams(postData);
      params.set('start', String(start));
      params.set('length', String(pageSize));
      params.set('draw', String(start / pageSize + 1));
      const response = await fetch('/Secure/MVC/Clients/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Cache-Control': 'no-cache' },
        body: params.toString(),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Clients grid request failed: ${response.status}`);
      const data = await response.json();
      rows.push(...data.data);
      if (rows.length >= data.recordsFiltered || data.data.length === 0) break;
    }
    return rows;
  }, listRequestData);

  const headers = ['Internal Record #', 'FirstName', 'LastName', 'IsActive', 'DateOfBirth', 'ClientTypes', 'PrimaryPhone', 'Email', 'Address', 'State', 'ServiceExitDate', 'ServiceExitReason', 'Groups'];
  const csvValue = (value) => {
    const text = Array.isArray(value) ? value.map((item) => item.Name || item).join(', ') : String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers.join(','), ...gridRows.map((row) => [
    row.Id, row.FirstName, row.LastName, row.IsActive ? 'Active' : 'Inactive', row.DateOfBirth,
    row.ClientTypes, row.PrimaryPhone, row.Email, row.Address, row.State, row.ServiceExitDate,
    row.ServiceExitReason, row.Groups,
  ].map(csvValue).join(','))].join('\r\n') + '\r\n';

  const fileName = 'clients.latest.tmp.csv';
  const filePath = path.join(downloadDir, fileName);
  page.removeListener('request', captureListRequest);
  fs.writeFileSync(filePath, csv, 'utf8');
  return { fileName, filePath };
}

/**
 * Logs in once, then exports the current Clients grid.
 */
async function exportClientsReport() {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
  });
  const page = await browser.newPage();

  // Surface real JavaScript errors from the page itself — DevExpress's
  // callback panel can fail silently in ways a screenshot won't explain.
  page.on('pageerror', (err) => console.error('  [PAGE ERROR]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('  [CONSOLE ERROR]', msg.text());
  });

  const results = [];
  const downloadDir = DOWNLOAD_DIR;

  try {
    await loginToNightingale(page);

    let downloaded;
    try {
      downloaded = await exportClients(page, downloadDir);
    } catch (err) {
      const temporaryPath = path.join(downloadDir, 'clients.latest.tmp.csv');
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      const debugDir = path.join(__dirname, '..', 'debug');
      let screenshotPath = null;
      try {
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        screenshotPath = path.join(debugDir, `error_clients_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch (screenshotErr) {
        // Don't let a screenshot failure hide the real error
      }
      console.error('  [CLIENTS] Scrape failed:', err.message);
      results.push({ report: 'clients', status: 'export_failed', error: err.message, screenshot: screenshotPath });
    }

    if (downloaded) {
      const filePath = path.join(downloadDir, 'clients.csv');
      try {
        fs.renameSync(downloaded.filePath, filePath);
        results.push({
          report: 'clients',
          status: 'success',
          fileName: 'clients.csv',
          filePath,
        });

        try {
          const newChurnsPath = path.join(downloadDir, 'new-churns.csv');
          const historyPath = path.join(downloadDir, 'all-churns.csv');
          const today = new Date();
          const detectedDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

          const churnResult = processChurnHistory(filePath, newChurnsPath, historyPath, detectedDate);

          console.log(`  [CHURNS] ${churnResult.newChurns} churn(s) recorded today; ${churnResult.historicalChurns} total in history.`);
        } catch (churnErr) {
          console.error('  [CHURNS] Churn detection failed (clients.csv export is unaffected):', churnErr.message);
        }
      } catch (err) {
        // Fresh data was fetched successfully, but the destination file couldn't
        // be replaced (commonly because it's open in Excel/OneDrive). Keep the
        // temp file instead of deleting it so the fresh data isn't lost, and
        // fail loudly instead of silently leaving the old clients.csv in place.
        console.error(`  [CLIENTS] Fetched fresh data but could not replace clients.csv (is it open in Excel?): ${err.message}`);
        results.push({
          report: 'clients',
          status: 'export_failed',
          error: `Fetched fresh data but could not save it as clients.csv: ${err.message}. Old clients.csv was left untouched; fresh data is at ${downloaded.filePath}`,
          pendingFile: downloaded.filePath,
        });
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { exportClientsReport };