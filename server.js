require('dotenv').config();
const path = require('path');
const express = require('express');
const { exportClientsReport } = require('./lib/nightingale');
const { uploadAllAndNotify } = require('./lib/sharepointUpload');

const app = express();
app.use(express.json());

// Only requests carrying the correct shared secret can trigger a run.
// Set this header in n8n's HTTP Request node as "x-api-key".
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/export-clients', requireApiKey, async (req, res) => {
  try {
    console.log('Starting Clients CSV export');

    const results = await exportClientsReport();
    const failures = results.filter((r) => r.status !== 'success');

    const { uploaded, uploadFailures } = await uploadAllAndNotify(results);

    console.log(`Done: ${results.length - failures.length}/${results.length} report exported; ${uploaded.length} file(s) uploaded`);

    res.json({
      summary: `${results.length - failures.length} of ${results.length} report exported`,
      hasFailures: failures.length > 0,
      uploaded,
      uploadFailures,
      downloadFolder: path.join(__dirname, 'downloads'),
      note: 'CSV files are saved locally and uploaded to SharePoint when configured.',
      results,
    });
  } catch (err) {
    console.error('Export job failed:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Nightingale export service listening on port ${port}`));
