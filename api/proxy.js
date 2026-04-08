// /api/proxy.js - hardened Vercel Node.js Function
export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
};

const STREAM_HEADERS = {
  ...CORS_HEADERS,
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const MAX_CONTENT_LENGTH = 24 * 1024 * 1024;
const MAX_INLINE_BYTES = 18 * 1024 * 1024;
const NON_STREAM_TIMEOUT = 120_000;
const STREAM_TIMEOUT = 240_000;

function setHeaders(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function setCors(res) {
  setHeaders(res, CORS_HEADERS);
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  setCors(res);
  res.status(status).json(payload);
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRetryAfter(rawText = '', fallback = 60) {
  const retryAfterHeader = String(rawText).match(/retry[- ]after\s*[:=]?\s*([\d.]+)s?/i);
  if (retryAfterHeader) return Math.max(1, Math.ceil(Number(retryAfterHeader[1])));
  const retryIn = String(rawText).match(/retry in ([\d.]+)s/i);
  if (retryIn) return Math.max(1, Math.ceil(Number(retryIn[1])) + 1);
  return fallback;
}

function extractGeminiText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  let text = '';
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part?.text === 'string') text += part.text;
    }
  }
  return text;
}

function extractPromptFeedbackMessage(data) {
  const feedback = data?.promptFeedback;
  if (!feedback) return '';
  const blockReason = feedback?.blockReason;
  if (blockReason) return `요청이 차단되었습니다: ${blockReason}`;
  return '';
}

function sanitizeMessageContent(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.trim()) return [{ type: 'text', text: content }];
  return [];
}

function convertAnthropicPartsToGemini(messages = []) {
  const allParts = [];

  for (const msg of messages) {
    const content = sanitizeMessageContent(msg?.content);
    for (const part of content) {
      if (part?.type === 'text') {
        const text = String(part.text ?? '');
        if (!text.trim()) continue;
        const prev = allParts[allParts.length - 1];
        if (prev && typeof prev.text === 'string' && !prev._afterBinary) {
          prev.text += `\n${text}`;
        } else {
          allParts.push({ text, _afterBinary: false });
        }
        continue;
      }

      if (part?.type === 'image') {
        const mimeType = part?.source?.media_type;
        const data = part?.source?.data;
        if (!mimeType || !data) continue;
        allParts.push({ inlineData: { mimeType, data } });
        allParts.push({ text: '', _afterBinary: true });
        continue;
      }

      if (part?.type === 'document') {
        const mimeType = part?.source?.media_type || 'application/pdf';
        const data = part?.source?.data;
        if (!data) continue;
        allParts.push({ inlineData: { mimeType, data } });
        allParts.push({ text: '', _afterBinary: true });
      }
    }
  }

  return allParts
    .map((part) => {
      if (part.inlineData) return part;
      const { _afterBinary, ...rest } = part;
      return rest;
    })
    .filter((part) => part.inlineData || (typeof part.text === 'string' && part.text.trim()));
}

function estimateInlineDataBytes(parts) {
  let total = 0;
  for (const part of parts) {
    const data = part?.inlineData?.data;
    if (typeof data === 'string') total += Math.floor((data.length * 3) / 4);
  }
  return total;
}

function commonPrefixLength(a = '', b = '') {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i += 1;
  return i;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildGeminiBody({ system, parts, stream, temperature }) {
  const generationConfig = stream
    ? {
        maxOutputTokens: 12000,
        temperature: temperature ?? 0.15,
        topP: 0.95,
        topK: 32,
      }
    : {
        maxOutputTokens: 7000,
        temperature: temperature ?? 0.1,
        topP: 0.9,
        topK: 24,
      };

  return {
    contents: [{ role: 'user', parts }],
    ...(system ? { systemInstruction: { parts: [{ text: String(system) }] } } : {}),
    generationConfig,
  };
}

function buildErrorPayload(status, rawText) {
  const parsed = safeJsonParse(rawText, {});
  const message =
    parsed?.error?.message ||
    parsed?.message ||
    rawText?.slice?.(0, 500) ||
    'Gemini API 오류';

  const retryAfter = status === 429 ? normalizeRetryAfter(rawText, 60) : undefined;

  return {
    error: {
      message,
      status,
      code: parsed?.error?.code,
    },
    ...(retryAfter ? { retryAfter } : {}),
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'POST 요청만 허용됩니다.' } });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
    return sendJson(res, 413, {
      error: { message: '요청 본문이 너무 큽니다. 파일을 더 잘게 나눠서 다시 시도해주세요.' },
    });
  }

  try {
    const body = typeof req.body === 'string' ? safeJsonParse(req.body, null) : req.body;
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: { message: '잘못된 JSON 본문입니다.' } });
    }

    const {
      apiKey: rawApiKey,
      system,
      messages,
      stream = true,
      model: rawModel,
      temperature,
    } = body;

    const apiKey = rawApiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey || typeof apiKey !== 'string') {
      return sendJson(res, 400, { error: { message: 'API Key가 없습니다.' } });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, 400, { error: { message: 'messages가 비어 있습니다.' } });
    }

    const model = ALLOWED_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL;
    const cleanParts = convertAnthropicPartsToGemini(messages);
    if (cleanParts.length === 0) {
      return sendJson(res, 400, { error: { message: '전달할 content가 없습니다.' } });
    }

    const inlineBytes = estimateInlineDataBytes(cleanParts);
    if (inlineBytes > MAX_INLINE_BYTES) {
      return sendJson(res, 413, {
        error: { message: '첨부 이미지/PDF 총 용량이 너무 큽니다. 파일 수를 줄이거나 PDF를 나눠 다시 시도해주세요.' },
      });
    }

    const geminiBody = buildGeminiBody({
      system,
      parts: cleanParts,
      stream: Boolean(stream),
      temperature,
    });

    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const apiRes = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      }, NON_STREAM_TIMEOUT);

      const rawText = await apiRes.text();
      if (!apiRes.ok) {
        return sendJson(res, apiRes.status, buildErrorPayload(apiRes.status, rawText));
      }

      const parsed = safeJsonParse(rawText, {});
      const text = extractGeminiText(parsed);
      const promptFeedback = extractPromptFeedbackMessage(parsed);

      if (!text && promptFeedback) {
        return sendJson(res, 422, { error: { message: promptFeedback } });
      }

      return sendJson(res, 200, {
        content: [{ type: 'text', text: text || '' }],
        meta: { model, stream: false },
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const apiRes = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    }, STREAM_TIMEOUT);

    if (!apiRes.ok) {
      const rawText = await apiRes.text();
      return sendJson(res, apiRes.status, buildErrorPayload(apiRes.status, rawText));
    }

    setHeaders(res, STREAM_HEADERS);
    res.setHeader('X-Proxy-Model', model);
    res.flushHeaders?.();

    const reader = apiRes.body?.getReader?.();
    if (!reader) {
      return sendJson(res, 500, { error: { message: '스트리밍 응답을 읽을 수 없습니다.' } });
    }

    let buffer = '';
    let sentText = '';
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventBlock of events) {
          const lines = eventBlock
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            const parsed = safeJsonParse(raw, null);
            if (!parsed) continue;

            const promptFeedback = extractPromptFeedbackMessage(parsed);
            if (promptFeedback) {
              writeSse(res, { type: 'error', error: { message: promptFeedback } });
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            const fullText = extractGeminiText(parsed);
            if (!fullText) continue;

            const prefixLen = commonPrefixLength(sentText, fullText);
            const delta = fullText.slice(prefixLen);
            sentText = fullText;

            if (delta) {
              writeSse(res, {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: delta },
              });
            }
          }
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (streamErr) {
      if (!res.writableEnded) {
        writeSse(res, {
          type: 'error',
          error: { message: streamErr?.name === 'AbortError' ? 'Gemini 요청 시간이 초과되었습니다.' : (streamErr?.message || '스트리밍 중 오류가 발생했습니다.') },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
  } catch (err) {
    return sendJson(res, 500, {
      error: {
        message: err?.name === 'AbortError'
          ? 'Gemini 요청 시간이 초과되었습니다.'
          : (err?.message || '서버 오류가 발생했습니다.'),
      },
    });
  }
}
