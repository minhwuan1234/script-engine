import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveClient } from './drive-sync.js';

test('Drive retries with the reserved ID and recovers an already uploaded file', async () => {
  const calls = [];
  const file = { id: 'local', original_name: 'example.txt', object_key: 'key' };
  const url = 'https://drive.google.com/file/d/remote/view';
  const drive = createDriveClient({
    folderId: 'folder',
    auth: { getAccessToken: async () => ({ token: 'test' }) },
    objects: { get: async () => ({ transformToByteArray: async () => Buffer.from('original') }) },
    fetchImpl: async (endpoint, options) => {
      if (endpoint.includes('generateIds')) return Response.json({ ids: ['remote'] });
      if (options.method === 'POST') {
        assert.deepEqual(calls[0], ['local', 'remote']);
        assert.match(options.body.toString(), /"id":"remote".*original/s);
        return new Response(null, { status: 409 });
      }
      assert.match(endpoint, /\/remote\?/);
      return Response.json({ parents: ['folder'], webViewLink: url });
    },
  });
  assert.equal(await drive.copy({ query: async (_, values) => calls.push(values) }, file), url);
  assert.deepEqual(calls, [['local', 'remote'], ['local', url]]);
});

test('Drive folder validation rejects broad sharing', async () => {
  const drive = createDriveClient({
    folderId: 'folder',
    auth: { getAccessToken: async () => ({ token: 'test' }) },
    fetchImpl: async (endpoint) => Response.json(endpoint.includes('/permissions') ?
      { permissions: [{ type: 'anyone' }] } : {
        driveId: 'shared', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true },
      }),
  });
  await assert.rejects(drive.checkFolder(), /restricted/);
});
