// Responses API adapter. Keep the repository instructions and the existing text gateway.
export async function callOpenAI(content, system, usage, onText = () => {}, {
  apiKey, model = 'gpt-6-sol', maxTokens = 32000, fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('Server missing OPENAI_API_KEY.');
  const input = content.map((block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    if (block.type === 'document' && block.source?.type === 'base64') {
      return { type: 'input_file', filename: block.title || 'document.pdf',
        file_data: `data:${block.source.media_type};base64,${block.source.data}` };
    }
    throw new Error(`Unsupported OpenAI input block: ${block.type}`);
  });
  const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, reasoning: { effort: 'medium' }, max_output_tokens: Number(maxTokens),
      stream: true, store: false,
      // Cache shared rules and selected styles; avoid writes for one-off uploads.
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      input: [
        { role: 'developer', content: system.map((block) => ({
          type: 'input_text', text: block.text, prompt_cache_breakpoint: { mode: 'explicit' },
        })) },
        { role: 'user', content: input },
      ],
    }),
  });
  if (!upstream.ok) {
    let message = `OpenAI API error ${upstream.status}`;
    try { message = (await upstream.json()).error?.message || message; } catch {}
    throw Object.assign(new Error(message), { status: upstream.status });
  }
  let text = '', buffer = '', terminal = null;
  const consume = (frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    const u = event.response?.usage;
    if (u) {
      const details = u.input_tokens_details || {};
      usage.cache_read_input_tokens = details.cached_tokens || 0;
      usage.cache_creation_input_tokens = details.cache_write_tokens || 0;
      usage.input_tokens = Math.max(0, (u.input_tokens || 0) - usage.cache_read_input_tokens - usage.cache_creation_input_tokens);
      usage.output_tokens = u.output_tokens || 0;
      usage.reasoning_tokens = u.output_tokens_details?.reasoning_tokens || 0;
    }
    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      if (event.delta.includes('\n')) onText(text);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      terminal = event.response;
      if (event.type === 'response.incomplete' && terminal.incomplete_details?.reason !== 'max_output_tokens') {
        throw new Error(`OpenAI response incomplete: ${terminal.incomplete_details?.reason || 'unknown reason'}`);
      }
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(event.response?.error?.message || event.message || 'OpenAI stream failed.');
    } else if (event.type === 'response.refusal.done') {
      throw new Error(event.refusal || 'OpenAI declined this request.');
    }
  };
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      consume(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!terminal) throw new Error('OpenAI stream ended before the response completed. Please retry.');
  let markdown = text.trim();
  const fenced = markdown.match(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/);
  if (fenced) markdown = fenced[1].trim();
  return { markdown, stopReason: terminal.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn' };
}

// Standard GPT-6 Sol rates; writes use the adapter's fixed 30-minute lifetime.
export function estimateOpenAICost(u, inputPrice = 2, outputPrice = 10) {
  const input = u.input_tokens || 0, read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
  const long = input + read + write > 272000;
  const usd = ((input + read * 0.1 + write * 1.25) * inputPrice * (long ? 2 : 1)
    + (u.output_tokens || 0) * outputPrice * (long ? 1.5 : 1)) / 1e6;
  return Math.round(usd * 10000) / 10000;
}
