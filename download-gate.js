import crypto from 'node:crypto';
import { domainToASCII } from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deny = () => Object.assign(new Error('Enter your email to unlock PDF downloads for this submission.'), { status: 403 });
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw invalid('Please enter a valid email address.');
  const email = value.trim();
  const parts = email.split('@');
  if (parts.length !== 2) throw invalid('Please enter a valid email address.');
  const [local, domain] = parts;
  const asciiDomain = domainToASCII(domain).toLowerCase();
  const labels = asciiDomain.split('.');
  if (email.length > 254 || local.length > 64 || !local || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
    || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw invalid('Please enter a valid email address.');
  }
  return `${local}@${asciiDomain}`;
}

// Different purposes prevent the owner capability from being used as a PDF grant.
// Neither capability is an admin token. Signed IDs cannot be swapped by the client.
export function createDownloadGate({ store, secret, confirmHubSpotLead, now = Date.now }) {
  if (!secret) throw new Error('A signing secret is required for download email gating.');
  const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const verify = (token, id, purpose) => {
    if (typeof token !== 'string' || token.length > 2048 || !uuid.test(id || '')) throw deny();
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw deny();
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw deny();
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw deny(); }
    if (payload.id !== id || payload.purpose !== purpose || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= now()) throw deny();
    return payload;
  };
  return {
    owner(id) {
      if (!uuid.test(id)) throw deny();
      return sign({ id, purpose: 'email-unlock', expiresAt: now() + 24 * 3600_000 });
    },
    async unlock({ submissionId, ownerToken, email } = {}) {
      verify(ownerToken, submissionId, 'email-unlock');
      const normalized = normalizeEmail(email);
      // Grant is issued only after the email is committed to PostgreSQL.
      const storedEmail = await store.captureDownloadEmail(submissionId, normalized);
      if (!storedEmail) throw deny();
      if (confirmHubSpotLead) await confirmHubSpotLead(submissionId, storedEmail);
      const expiresAt = now() + 3600_000;
      return { ok: true, expiresAt, downloadToken: sign({ id: submissionId,
        purpose: 'pdf-download', emailHash: digest(storedEmail), expiresAt }) };
    },
    async authorize({ submissionId, version, token } = {}) {
      if (!['A', 'B'].includes(version)) throw invalid('Choose Version A or B.');
      const grant = verify(token, submissionId, 'pdf-download');
      const row = await store.get(submissionId);
      if (!row?.download_email || grant.emailHash !== digest(row.download_email)) throw deny();
      const letter = version.toLowerCase();
      const result = row.result;
      const text = result?.[`version_${letter}_text`] ?? result?.[`version_${letter}_md`];
      if (typeof text !== 'string' || !text.trim()) throw deny();
      return { version, title: result.title || result[`version_${letter}_title`],
        style: result[`version_${letter}_title`] || '', duration: row.duration, text };
    },
  };
}

export async function readDownloadJSON(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw invalid('Invalid request.'); }
}

export async function authorizedPdfInput(req, gate) {
  if (!gate) throw Object.assign(new Error('Downloads are temporarily unavailable.'), { status: 503 });
  const input = await readDownloadJSON(req);
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Ignore client-supplied script/title/email fields. PDFs use the stored result.
  return gate.authorize({ submissionId: input.submissionId, version: input.version, token });
}
