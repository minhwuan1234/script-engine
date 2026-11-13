import { createSubmissionStore } from './submission-store.js';
import { REPORT_HEADERS, startReportWorker } from './sheets-sync.js';

const required = (env, names) => {
  for (const name of names) if (!env[name]) throw new Error(`Missing ${name} for submission archive.`);
};

export function archiveConfig(env) {
  if (env.SUBMISSION_ARCHIVE_ENABLED !== 'true') return null;
  required(env, ['DATABASE_URL', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET',
    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'ADMIN_TOKEN', 'PUBLIC_APP_URL']);
  const url = new URL(env.PUBLIC_APP_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_APP_URL must be an HTTPS origin without credentials, query or path.');
  }
  const config = { baseUrl: url.origin, sheetsEnabled: env.REPORT_SHEETS_ENABLED === 'true' };
  if (config.sheetsEnabled) required(env, ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SHEET_ID']);
  return config;
}

export function createSheetsClient({ auth, spreadsheetId, tab = 'Submissions', fetchImpl = fetch }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) throw new Error('Invalid GOOGLE_SHEET_ID.');
  if (!tab || tab.length > 80 || /[\[\]*?:/\\]/.test(tab)) throw new Error('Invalid GOOGLE_SHEET_TAB.');
  const a1 = `'${tab.replaceAll("'", "''")}'`;
  const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  async function request(path, method = 'GET', body) {
    const { token } = await auth.getAccessToken();
    const response = await fetchImpl(endpoint + path, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Sheets request failed (${response.status}).`);
    return response.json();
  }
  const write = (range, values) => request(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    'PUT', { values, majorDimension: 'ROWS' });
  return {
    async ensure(row) {
      const data = await request('?fields=sheets.properties');
      let sheet = data.sheets?.find((item) => item.properties.title === tab)?.properties;
      if (!sheet) {
        const result = await request(':batchUpdate', 'POST', { requests: [{ addSheet: {
          properties: { title: tab, gridProperties: { rowCount: Math.max(1000, row + 100), columnCount: 11, frozenRowCount: 1 } },
        } }] });
        sheet = result.replies[0].addSheet.properties;
        await request(':batchUpdate', 'POST', { requests: [
          { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { backgroundColor: { red: 1, green: .58, blue: .21 }, textFormat: { bold: true } } },
            fields: 'userEnteredFormat' } },
          { repeatCell: { range: { sheetId: sheet.sheetId },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
            fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
          { updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 4 },
            properties: { pixelSize: 350 }, fields: 'pixelSize' } },
        ] });
      } else if (sheet.gridProperties.rowCount < row || sheet.gridProperties.columnCount < 11) {
        await request(':batchUpdate', 'POST', { requests: [{ updateSheetProperties: {
          properties: { sheetId: sheet.sheetId, gridProperties: {
            rowCount: Math.max(sheet.gridProperties.rowCount, row + 100),
            columnCount: Math.max(sheet.gridProperties.columnCount, 11),
          } }, fields: 'gridProperties.rowCount,gridProperties.columnCount',
        } }] });
      }
      await write(`${a1}!A1:K1`, [REPORT_HEADERS]);
    },
    write(row, values) { return write(`${a1}!A${row}:K${row}`, [values]); },
  };
}

export async function createArchiveRuntime(env = process.env) {
  const config = archiveConfig(env);
  if (!config) return null;
  const [{ Pool }, { S3Client, PutObjectCommand, GetObjectCommand }] = await Promise.all([
    import('pg'), import('@aws-sdk/client-s3'),
  ]);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5,
    connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 15000 });
  pool.on('error', () => console.error('Submission database connection unavailable.'));
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 3,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } });
  const objects = {
    put: (key, body, contentType) => s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET,
      Key: key, Body: body, ContentType: contentType }), { abortSignal: AbortSignal.timeout(60000) }),
    get: async (key) => (await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      { abortSignal: AbortSignal.timeout(60000) })).Body,
  };
  const store = createSubmissionStore({ pool, objects });
  await store.migrate();
  let stopWorker = () => {};
  if (config.sheetsEnabled) {
    const { JWT } = await import('google-auth-library');
    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!credentials.client_email || !credentials.private_key) throw new Error('Invalid service account credentials.');
    const auth = new JWT({ email: credentials.client_email, key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = createSheetsClient({ auth, spreadsheetId: env.GOOGLE_SHEET_ID, tab: env.GOOGLE_SHEET_TAB || 'Submissions' });
    stopWorker = startReportWorker({ pool, sheets, baseUrl: config.baseUrl });
  }
  return { store, baseUrl: config.baseUrl, sheetsEnabled: config.sheetsEnabled,
    async close() { stopWorker(); s3.destroy(); await pool.end(); } };
}
