const form = document.querySelector('#access');
const message = document.querySelector('#message');
const id = location.pathname.split('/').pop();
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = document.querySelector('#token').value;
  const headers = { Authorization: `Bearer ${token}` };
  message.textContent = 'Loading…';
  document.querySelector('#details').hidden = true;
  try {
    const response = await fetch(`/api/admin/submissions/${id}`, { headers, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Invalid admin token.' : 'Could not load submission.');
    const data = await response.json();
    document.querySelector('#meta').textContent = `${data.id} · ${data.status} · ${data.created_at}`;
    document.querySelector('#original').value = data.input_text;
    const files = document.querySelector('#files');
    files.replaceChildren();
    for (const file of data.files) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = file.original_name + (file.stored ? '' : ' (upload incomplete)');
      button.disabled = !file.stored;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const download = await fetch(`/api/admin/submissions/${id}/files/${file.id}`, { headers, cache: 'no-store' });
          if (!download.ok) throw new Error('Download unavailable.');
          const url = URL.createObjectURL(await download.blob());
          const link = document.createElement('a'); link.href = url; link.download = file.original_name;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          message.textContent = '';
        } catch { message.textContent = 'Could not download file. Please retry.'; }
        finally { button.disabled = false; }
      });
      files.append(button);
    }
    if (!data.files.length) files.textContent = 'No documents attached.';
    document.querySelector('#details').hidden = false;
    message.textContent = '';
    document.querySelector('#token').value = '';
  } catch (error) { message.textContent = error.message; }
});
