// Vercel Node.js Function
export const config = { maxDuration: 300 }; // 60→300: 긴 분석 타임아웃 방지

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash',
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
]);
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // model, stream 파라미터 수신 (GPT 버전은 이걸 무시하는 버그 있었음)
    const { apiKey, system, messages, stream = false, model: reqModel } = body;

    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) return res.status(400).json({ error: { message: 'API Key 없음' } });
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: { message: 'messages 형식 오류' } });

    // 화이트리스트 검증 후 모델 선택
    const model = (reqModel && ALLOWED_MODELS.has(reqModel)) ? reqModel : DEFAULT_MODEL;

    // Anthropic 형식 → Gemini parts 변환
    const allParts = [];
    for (const msg of messages) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content || '') }];
      for (const part of content) {
        if (part.type === 'text') {
          // 텍스트 파트 병합 (이미지 사이 텍스트 처리)
          const prev = allParts[allParts.length - 1];
          if (prev && prev.text !== undefined && !prev._afterImage) {
            prev.text += '\n' + part.text;
          } else {
            allParts.push({ text: part.text || '', _afterImage: false });
          }
        } else if (part.type === 'image') {
          allParts.push({ inlineData: { mimeType: part.source?.media_type || 'image/jpeg', data: part.source?.data || '' } });
          allParts.push({ text: '', _afterImage: true });
        } else if (part.type === 'document') {
          allParts.push({ inlineData: { mimeType: 'application/pdf', data: part.source?.data || '' } });
          allParts.push({ text: '', _afterImage: true });
        }
      }
    }

    const cleanParts = allParts
      .map(p => { if (p.inlineData) return p; const { _afterImage, ...rest } = p; return rest; })
      .filter(p => p.inlineData || (p.text && p.text.trim()));

    if (!cleanParts.length) return res.status(400).json({ error: { message: '전송할 내용이 없습니다.' } });

    // 오류 파싱 헬퍼 + retryAfter 반환 (GPT 버전에 없던 기능)
    const parseError = (rawText, status) => {
      let errMsg = `Gemini API 오류 (${status})`;
      try { errMsg = JSON.parse(rawText).error?.message || errMsg; } catch { errMsg = rawText.slice(0, 300) || errMsg; }
      const m = rawText.match(/retry in ([\d.]+)s/i);
      const retryAfter = m ? Math.ceil(parseFloat(m[1])) + 2 : 65;
      return { errMsg, retryAfter };
    };

    const geminiBody = {
      contents: [{ role: 'user', parts: cleanParts }],
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: stream
        ? { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 }
        : { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 },
    };

    // ── 비스트리밍 ──
    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const apiRes = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
      const resText = await apiRes.text();
      if (!apiRes.ok) {
        const { errMsg, retryAfter } = parseError(resText, apiRes.status);
        return res.status(apiRes.status).json({ error: { message: errMsg }, retryAfter });
      }
      let text = '';
      try {
        const d = JSON.parse(resText);
        // thinking 파트 제외, text 파트만 병합
        text = d.candidates?.[0]?.content?.parts
          ?.filter(p => p.text !== undefined && !p.thought)
          .map(p => p.text || '')
          .join('') || '';
      } catch {}
      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    // ── 스트리밍 (GPT 버전에 완전히 없던 기능) ──
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
    const apiRes = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      const { errMsg, retryAfter } = parseError(errText, apiRes.status);
      return res.status(apiRes.status).json({ error: { message: errMsg }, retryAfter });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.write('data: [DONE]\n\n'); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const text = j.candidates?.[0]?.content?.parts
              ?.filter(p => p.text !== undefined && !p.thought)
              .map(p => p.text || '')
              .join('') || '';
            if (text) res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
          } catch {}
        }
      }
    } catch {}
    finally { res.end(); }

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: { message: e.message || '서버 오류' } });
  }
}
