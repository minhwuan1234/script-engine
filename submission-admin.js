import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export function authorized(req, token) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !req.headers.authorization?.startsWith('Bearer ')) return false;
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleSubmissionAdmin(req, res, pathname, runtime, token) {
  if (!runtime || req.method !== 'GET') return false;
  if (pathname === '/api/admin/archive-status') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (!authorized(req, token)) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Admin authentication required.' })); return true;
    }
    const counts = (await runtime.store.pool.query(`SELECT count(*)::int AS submissions,
      count(*) FILTER (WHERE revision > synced_revision)::int AS pending_sync,
      count(*) FILTER (WHERE sync_error IS NOT NULL)::int AS sync_errors,
      count(*) FILTER (WHERE status IN ('archive_failed','interrupted'))::int AS incomplete
      FROM submissions`)).rows[0];
    res.end(JSON.stringify({ archiveEnabled: true, sheetsEnabled: runtime.sheetsEnabled, ...counts }));
    return true;
  }
  if (new RegExp(`^/admin/submissions/${uuid}$`).test(pathname)) {
    const html = await readFile(new URL('./submission-admin.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.end(html); return true;
  }
  if (pathname === '/admin/submission-viewer.js' || pathname === '/admin/submission-viewer.css') {
    const script = pathname.endsWith('.js');
    res.writeHead(200, { 'Content-Type': script ? 'text/javascript' : 'text/css', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(new URL(script ? './submission-viewer.js' : './submission-viewer.css', import.meta.url)));
    return true;
  }
  const match = new RegExp(`^/api/admin/submissions/(${uuid})(?:/files/(${uuid}))?$`).exec(pathname);
  if (!match) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authorized(req, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin authentication required.' })); return true;
  }
  if (match[2]) {
    const file = await runtime.store.file(match[1], match[2]);
    if (!file) { res.writeHead(404); res.end('File not found'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.original_name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}` });
    await pipeline(file.body, res);
  } else {
    const data = await runtime.store.get(match[1]);
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data || { error: 'Submission not found.' }));
  }
  return true;
}
