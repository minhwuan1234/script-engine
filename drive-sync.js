import { randomUUID } from 'node:crypto';

export function createDriveClient({ auth, folderId, objects, fetchImpl = fetch }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) throw new Error('Invalid GOOGLE_DRIVE_FOLDER_ID.');

  async function request(path, options = {}) {
    const { token } = await auth.getAccessToken();
    const response = await fetchImpl('https://www.googleapis.com' + path, {
      ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw Object.assign(new Error('Google Drive request failed.'), { status: response.status });
    return response.json();
  }

  return {
    async checkFolder() {
      const folder = await request(`/drive/v3/files/${folderId}?supportsAllDrives=true&fields=driveId,mimeType,trashed,capabilities(canAddChildren)`);
      if (!folder.driveId || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder'
          || !folder.capabilities?.canAddChildren) throw new Error('Drive folder is unavailable for upload.');
      let pageToken = '';
      do {
        const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'nextPageToken,permissions(type)' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await request(`/drive/v3/files/${folderId}/permissions?${params}`);
        if (page.permissions?.some(({ type }) => type === 'anyone' || type === 'domain')) {
          throw new Error('Drive folder must be restricted to named users and groups.');
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    },
    async copy(client, file) {
      let id = file.drive_file_id;
      if (!id) {
        const result = await request('/drive/v3/files/generateIds?count=1&space=drive');
        [id] = result.ids;
        // Persist the ID before upload so retries after an ambiguous response reuse it.
        await client.query('UPDATE submission_files SET drive_file_id=$2 WHERE id=$1', [file.id, id]);
      }
      const boundary = 'script-studio-' + randomUUID();
      const metadata = JSON.stringify({ id, name: file.original_name, parents: [folderId] });
      const source = await objects.get(file.object_key);
      const bytes = await source.transformToByteArray();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      let uploaded;
      try {
        uploaded = await request('/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=webViewLink', {
          method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
        });
      } catch (error) {
        if (error.status !== 409) throw error;
        uploaded = await request(`/drive/v3/files/${id}?supportsAllDrives=true&fields=webViewLink,parents,trashed`);
        if (uploaded.trashed || !uploaded.parents?.includes(folderId)) throw error;
      }
      if (!uploaded.webViewLink) throw new Error('Drive file has no view link.');
      await client.query('UPDATE submission_files SET drive_view_url=$2 WHERE id=$1', [file.id, uploaded.webViewLink]);
      return uploaded.webViewLink;
    },
  };
}
