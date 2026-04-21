import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function mapModel(model) {
  if (!model || String(model).toLowerCase().includes('claude')) {
    return process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  }
  return model;
}

function readEnvFileKey() {
  try {
    const envPath = join(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = line.slice(0, eqIdx).trim();
      if (key !== 'OPENAI_API_KEY' && key !== 'CHATGPT_API_KEY') continue;

      let value = line.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  } catch {
    // Ignore read errors and rely on process.env only.
  }
  return '';
}

function getApiKey() {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.CHATGPT_API_KEY?.trim() ||
    readEnvFileKey()
  );
}

function toInputContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: JSON.stringify(content || {}) }];
  }

  const converted = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'text' && typeof item.text === 'string') {
      converted.push({ type: 'input_text', text: item.text });
      continue;
    }

    if (item.type === 'image' && item.source?.data) {
      const mediaType = item.source.media_type || 'image/jpeg';
      converted.push({
        type: 'input_image',
        image_url: `data:${mediaType};base64,${item.source.data}`,
      });
      continue;
    }

    if (item.type === 'document' && item.source?.data) {
      const mediaType = item.source.media_type || 'application/pdf';
      converted.push({
        type: 'input_file',
        filename: mediaType === 'application/pdf' ? 'document.pdf' : 'document.bin',
        file_data: `data:${mediaType};base64,${item.source.data}`,
      });
      continue;
    }
  }

  return converted.length ? converted : [{ type: 'input_text', text: JSON.stringify(content) }];
}

function buildOpenAIInput(body) {
  if (Array.isArray(body?.messages) && body.messages.length) {
    return body.messages.map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: toInputContent(m?.content),
    }));
  }

  return [{
    role: 'user',
    content: [{ type: 'input_text', text: body?.prompt || '' }],
  }];
}

function extractText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const chunks = [];
  for (const out of data?.output || []) {
    for (const c of out?.content || []) {
      if (c?.type === 'output_text' && typeof c.text === 'string') chunks.push(c.text);
      if (c?.type === 'text' && typeof c.text === 'string') chunks.push(c.text);
    }
  }

  return chunks.join('\n').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY (or CHATGPT_API_KEY).' });
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {});

    const openaiPayload = {
      model: mapModel(body?.model),
      input: buildOpenAIInput(body),
      max_output_tokens: Math.min(Number(body?.max_tokens) || 1000, 4000),
    };

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openaiPayload),
    });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: data?.error?.message || `OpenAI error (${resp.status})`,
        details: data,
      });
    }

    const text = extractText(data);
    const adapted = {
      id: data?.id,
      model: data?.model,
      content: [{ type: 'text', text: text || '{}' }],
      raw: data,
    };

    return res.status(200).json(adapted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
