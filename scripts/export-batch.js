require('dotenv').config();
const { exportClientsReport } = require('../lib/nightingale');
const { uploadAllAndNotify } = require('../lib/sharepointUpload');

async function main() {
  console.log('Exporting the Clients CSV report\n');
  const results = await exportClientsReport();

  console.log('--- Export Results ---');
  for (const r of results) {
    if (r.status === 'success') {
      console.log(`  ✓ ${r.report}: ${r.fileName}`);
    } else {
      console.log(`  ✗ ${r.report}: FAILED — ${r.error}`);
    }
  }

  const exportFailures = results.filter((r) => r.status !== 'success');
  console.log(`\n${results.length - exportFailures.length}/${results.length} report exported successfully.`);
  console.log('\n--- SharePoint Upload ---');
  const { uploaded, uploadFailures } = await uploadAllAndNotify(results);
  console.log(`${uploaded.length} file(s) uploaded to SharePoint.`);
  for (const failure of uploadFailures) {
    console.log(`  Upload failed for ${failure.fileName}: ${failure.error}`);
  }

  if (exportFailures.length > 0 || uploadFailures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Batch export failed:', err);
  process.exit(1);
});
