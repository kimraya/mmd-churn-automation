const fs = require('fs');
const path = require('path');

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getGraphAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 60000) return cachedToken;

  const tenantId = process.env.MS_TENANT_ID;
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to get Graph token: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function uploadFileToSharePoint(filePath, fileName) {
  const token = await getGraphAccessToken();
  const siteId = process.env.SHAREPOINT_SITE_ID;
  const driveId = process.env.SHAREPOINT_DRIVE_ID;
  const dropoffPath = process.env.SHAREPOINT_DROPOFF_PATH;

  const encodedFolder = dropoffPath.split('/').map(encodeURIComponent).join('/');
  const encodedFileName = encodeURIComponent(fileName);

  const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/root:/${encodedFolder}/${encodedFileName}:/content`;

  const fileBuffer = fs.readFileSync(filePath);

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    throw new Error(`Upload failed for ${fileName}: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function notifyN8n(uploadedFileNames) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('  No N8N_WEBHOOK_URL set — skipping trigger (files are uploaded, but you\'ll need to run the workflow manually).');
    return;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadedCount: uploadedFileNames.length, files: uploadedFileNames }),
    });
    if (!res.ok) {
      console.error(`  ✗ n8n webhook call returned ${res.status} — you'll need to run the workflow manually this time.`);
    } else {
      console.log(`  → n8n workflow triggered (${uploadedFileNames.length} file(s))`);
    }
  } catch (err) {
    console.error(`  ✗ Failed to reach n8n webhook: ${err.message} — you'll need to run the workflow manually this time.`);
  }
}

const REQUIRED_SHAREPOINT_VARS = [
  'MS_TENANT_ID',
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'SHAREPOINT_SITE_ID',
  'SHAREPOINT_DRIVE_ID',
  'SHAREPOINT_DROPOFF_PATH',
];

async function uploadAllAndNotify(results) {
  const successfulExports = results.filter((r) => r.status === 'success');
  for (const fileName of ['all-churns.csv', 'new-churns.csv']) {
    const filePath = path.join(__dirname, '..', 'downloads', fileName);
    if (fs.existsSync(filePath)) successfulExports.push({ fileName, filePath });
  }
  const uploaded = [];
  const uploadFailures = [];

  const missingVars = REQUIRED_SHAREPOINT_VARS.filter((name) => !process.env[name]);
  if (missingVars.length > 0) {
    console.log(`  SharePoint not configured yet (missing ${missingVars.join(', ')}) — skipping upload. Exported files are still saved locally for manual upload.`);
    return { uploaded, uploadFailures };
  }

  for (const r of successfulExports) {
    try {
      await uploadFileToSharePoint(r.filePath, r.fileName);
      uploaded.push(r.fileName);
      console.log(`  ↑ Uploaded ${r.fileName} to SharePoint`);
    } catch (err) {
      uploadFailures.push({ fileName: r.fileName, error: err.message });
      console.error(`  ✗ Upload failed for ${r.fileName}: ${err.message}`);
    }
  }

  if (uploaded.length > 0) {
    await notifyN8n(uploaded);
  } else {
    console.log('  No files uploaded successfully — skipping n8n trigger.');
  }

  return { uploaded, uploadFailures };
}

module.exports = { uploadAllAndNotify };
