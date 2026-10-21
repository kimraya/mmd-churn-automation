const fs = require('fs');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).filter((line, index, allLines) => line || index < allLines.length - 1);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });

  return { headers, rows };
}

function normalizeHeader(header) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findHeader(headers, expectedName) {
  const expected = normalizeHeader(expectedName);
  const aliases = expected === 'internalrecordnumber' ? ['internalrecordnumber', 'internalrecord'] : [expected];
  return headers.find((header) => aliases.includes(normalizeHeader(header)));
}

function hasValue(value) {
  return String(value || '').trim() !== '';
}

function csvValue(value) {
  const text = String(value || '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, headers, rows) {
  const content = [
    headers.map(csvValue).join(','),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(',')),
  ].join('\r\n') + '\r\n';
  // BOM so Excel/SharePoint open the CSV as UTF-8, not Windows-1252
  fs.writeFileSync(filePath, '\ufeff' + content, 'utf8');
}

function normalizeMatchValue(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const dayFirst = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dayFirst) return `${dayFirst[3]}${dayFirst[2].padStart(2, '0')}${dayFirst[1].padStart(2, '0')}`;

  const yearFirst = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (yearFirst) return `${yearFirst[1]}${yearFirst[2].padStart(2, '0')}${yearFirst[3].padStart(2, '0')}`;

  return normalizeMatchValue(text);
}

function processChurnHistory(currentPath, historyPath, detectedDate) {
  const current = readCsv(currentPath);
  const recordHeader = findHeader(current.headers, 'InternalRecordNumber');
  const exitDateHeader = findHeader(current.headers, 'ServiceExitDate');
  const exitReasonHeader = findHeader(current.headers, 'ServiceExitReason');
  if (!recordHeader || !exitDateHeader || !exitReasonHeader) {
    throw new Error('The Clients export must include Internal Record #, Service Exit Date, and Service Exit Reason.');
  }

  const history = fs.existsSync(historyPath) ? readCsv(historyPath) : null;
  const historyByRecord = new Map();
  const historyDateHeader = history && findHeader(history.headers, 'DetectedDate');

  if (history) {
    const historyRecordHeader = findHeader(history.headers, 'InternalRecordNumber');
    if (historyRecordHeader) {
      for (const row of history.rows) historyByRecord.set(String(row[historyRecordHeader]).trim(), row);
    }
  }

  const historyHeaders = ['DetectedDate', ...current.headers];
  for (const row of current.rows) {
    const recordNumber = String(row[recordHeader] || '').trim();
    const nowHasExit = hasValue(row[exitDateHeader]) || hasValue(row[exitReasonHeader]);
    if (!recordNumber || !nowHasExit) continue;

    const existing = historyByRecord.get(recordNumber);
    const enrichedRow = {
      DetectedDate: existing?.DetectedDate || (historyDateHeader ? existing?.[historyDateHeader] : detectedDate) || detectedDate,
      ...row,
    };
    historyByRecord.set(recordNumber, enrichedRow);
  }

  const sortByExitDateAsc = (rows) => [...rows].sort((a, b) => normalizeDate(a[exitDateHeader]).localeCompare(normalizeDate(b[exitDateHeader])));

  writeCsv(historyPath, historyHeaders, sortByExitDateAsc([...historyByRecord.values()]));
  return { historicalChurns: historyByRecord.size };
}

module.exports = { processChurnHistory };
