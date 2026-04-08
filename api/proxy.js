export const config = { maxDuration: 300 };

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-3-flash-preview'];
const MAX_ATTACH_BYTES_APPROX = 18 * 1024 * 1024; // base64 decoded rough cap
const REQUEST_TIMEOUT_MS = 120000;

function json(res, status, payload) {
  if (!res.headersSent) res.status(status).json(payload);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); }
    catch { throw new Error('잘못된 JSON 요청입니다.'); }
  }
  return req.body;
}

function estimateInlineBytes(base64 = '') {
  const len = base64.length;
  return Math.floor((len * 3) / 4);
}

function isBusyStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

function isBusyMessage(msg = '') {
  return /high demand|temporarily unavailable|resource exhausted|overloaded|try again later|quota|rate limit/i.test(msg);
}

function normalizeRequestedModel(requested) {
  return FALLBACK_MODELS.includes(requested) ? requested : DEFAULT_MODEL;
}

function anthropicToGeminiParts(messages) {
  const allParts = [];
  let approxBytes = 0;

  for (const msg of messages) {
    const content = Array.isArray(msg?.content) ? msg.content : [{ type: 'text', text: String(msg?.content ?? '') }];
    for (const part of content) {
      if (part?.type === 'text') {
        const text = String(part.text ?? '');
        const prev = allParts[allParts.length - 1];
        if (prev && prev.text !== undefined && !prev._afterBinary) prev.text += `\n${text}`;
        else allParts.push({ text, _afterBinary: false });
      } else if (part?.type === 'image' && part?.source?.data && part?.source?.media_type) {
        approxBytes += estimateInlineBytes(part.source.data);
        allParts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
        allParts.push({ text: '', _afterBinary: true });
      } else if (part?.type === 'document' && part?.source?.data) {
        approxBytes += estimateInlineBytes(part.source.data);
        allParts.push({ inlineData: { mimeType: 'application/pdf', data: part.source.data } });
        allParts.push({ text: '', _afterBinary: true });
      }
    }
  }

  const cleanParts = allParts
    .map((p) => {
      if (p.inlineData) return p;
      const { _afterBinary, ...rest } = p;
      return rest;
    })
    .filter((p) => p.inlineData || (p.text && p.text.trim()));

  return { cleanParts, approxBytes };
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildGeminiBody({ system, parts, stream }) {
  return {
    contents: [{ role: 'user', parts }],
    ...(system ? { systemInstruction: { parts: [{ text: String(system) }] } } : {}),
    generationConfig: stream
      ? { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 }
      : { maxOutputTokens: 8000, temperature: 0.1, topP: 0.95, topK: 40 },
  };
}

async function callGeminiOnce({ apiKey, model, geminiBody, stream }) {
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}&key=${apiKey}`
    .replace(':streamGenerateContent?alt=sse&key=', ':streamGenerateContent?alt=sse&key=')
    .replace(':generateContent&key=', ':generateContent?key=');

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody),
  }, stream ? 180000 : REQUEST_TIMEOUT_MS);

  const text = await res.text();
  return { res, text };
}

function parseErrorInfo(raw, fallback = 'Gemini API 오류') {
  try {
    const data = JSON.parse(raw);
    const message = data?.error?.message || fallback;
    return { message, raw: data };
  } catch {
    return { message: String(raw || fallback).slice(0, 500), raw: null };
  }
}

async function callGeminiWithFallback({ apiKey, system, parts, stream, requestedModel }) {
  const first = normalizeRequestedModel(requestedModel);
  const models = [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const geminiBody = buildGeminiBody({ system, parts, stream });
    try {
      const { res, text } = await callGeminiOnce({ apiKey, model, geminiBody, stream });
      if (res.ok) return { ok: true, model, text, stream };

      const info = parseErrorInfo(text);
      lastError = { status: res.status, message: info.message, model };

      const shouldRetryNextModel = isBusyStatus(res.status) || isBusyMessage(info.message);
      if (shouldRetryNextModel && i < models.length - 1) continue;

      return { ok: false, status: res.status, message: info.message, model };
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'Gemini 응답 시간 초과' : (err?.message || 'Gemini 호출 실패');
      lastError = { status: 504, message: msg, model };
      if (i < models.length - 1) continue;
    }
  }

  return {
    ok: false,
    status: lastError?.status || 503,
    message: lastError?.message || '사용 가능한 무료 모델이 모두 혼잡 상태입니다. 잠시 후 다시 시도해주세요.',
    model: lastError?.model || DEFAULT_MODEL,
  };
}

function writeSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

function forwardGeminiSseToClient(rawText, res) {
  const lines = rawText.split('\n');
  let sent = '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const full = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (!full || full.length <= sent.length) continue;
      const delta = full.slice(sent.length);
      sent = full;
      if (delta) {
        res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta } })}\n\n`);
      }
    } catch {
      // ignore malformed SSE chunks
    }
  }
  res.write('data: [DONE]\n\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: { message: 'POST만 허용됩니다.' } });

  try {
    const body = parseBody(req);
    const {
      apiKey: bodyApiKey,
      system,
      messages,
      stream = true,
      model,
    } = body || {};

    const apiKey = bodyApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return json(res, 400, { error: { message: 'API Key가 없습니다.' } });
    if (!Array.isArray(messages) || messages.length === 0) {
      return json(res, 400, { error: { message: 'messages 배열이 비어 있습니다.' } });
    }

    const { cleanParts, approxBytes } = anthropicToGeminiParts(messages);
    if (cleanParts.length === 0) {
      return json(res, 400, { error: { message: '전송할 텍스트/이미지/PDF가 없습니다.' } });
    }
    if (approxBytes > MAX_ATTACH_BYTES_APPROX) {
      return json(res, 413, { error: { message: '첨부 용량이 너무 큽니다. JPG는 선명한 한두 장씩, PDF는 문제 단위로 나눠 업로드해주세요.' } });
    }

    const result = await callGeminiWithFallback({
      apiKey,
      system,
      parts: cleanParts,
      stream: !!stream,
      requestedModel: model,
    });

    if (!result.ok) {
      const busy = isBusyStatus(result.status) || isBusyMessage(result.message);
      return json(res, result.status || 500, {
        error: {
          message: busy
            ? `현재 무료 모델이 혼잡 상태입니다. 잠시 후 다시 시도해주세요. (마지막 시도 모델: ${result.model})`
            : result.message,
        },
        busy,
        model: result.model,
        allowedFreeModels: FALLBACK_MODELS,
      });
    }

    if (!stream) {
      let text = '';
      try {
        const data = JSON.parse(result.text);
        text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      } catch {}
      return json(res, 200, {
        content: [{ type: 'text', text }],
        model: result.model,
        allowedFreeModels: FALLBACK_MODELS,
      });
    }

    writeSseHeaders(res);
    forwardGeminiSseToClient(result.text, res);
    return res.end();
  } catch (e) {
    return json(res, 500, { error: { message: e?.message || '서버 오류' } });
  }
}
