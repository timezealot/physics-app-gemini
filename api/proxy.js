// Vercel Node.js Function — maxDuration 300초 (타임아웃 방지)
export const config = { maxDuration: 300 };

// 허용 모델 화이트리스트 (보안: 임의 모델 호출 방지)
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash',
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
]);
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // body 파싱
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { apiKey, system, messages, stream = true, model: reqModel } = body;

    if (!apiKey) {
      return res.status(400).json({ error: { message: 'API Key가 없습니다.' } });
    }
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'messages가 없습니다.' } });
    }

    // 모델 선택: 요청에서 받은 모델이 허용 목록에 있으면 사용, 아니면 기본값
    const model = (reqModel && ALLOWED_MODELS.has(reqModel)) ? reqModel : DEFAULT_MODEL;

    // Anthropic 형식 → Gemini 형식 변환
    const allParts = [];
    for (const msg of messages) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content || '') }];

      for (const part of content) {
        if (part.type === 'text') {
          const prev = allParts[allParts.length - 1];
          if (prev && prev.text !== undefined && !prev._afterImage) {
            prev.text += '\n' + part.text;
          } else {
            allParts.push({ text: part.text || '', _afterImage: false });
          }
        } else if (part.type === 'image') {
          allParts.push({
            inlineData: { mimeType: part.source?.media_type || 'image/jpeg', data: part.source?.data || '' }
          });
          allParts.push({ text: '', _afterImage: true });
        } else if (part.type === 'document') {
          allParts.push({
            inlineData: { mimeType: 'application/pdf', data: part.source?.data || '' }
          });
          allParts.push({ text: '', _afterImage: true });
        }
      }
    }

    // 빈 텍스트 파트 제거 + _afterImage 플래그 제거
    const cleanParts = allParts
      .map(p => {
        if (p.inlineData) return p;
        const { _afterImage, ...rest } = p;
        return rest;
      })
      .filter(p => p.inlineData || (p.text && p.text.trim()));

    if (!cleanParts.length) {
      return res.status(400).json({ error: { message: '전송할 내용이 없습니다.' } });
    }

    // generation 설정: 스트리밍(분석)은 낮은 temperature, 비스트리밍(OCR)은 약간 높게
    const generationConfig = stream
      ? { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 }
      : { maxOutputTokens: 8000,  temperature: 0.4, topP: 0.95, topK: 40 };

    const geminiBody = {
      contents: [{ role: 'user', parts: cleanParts }],
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig,
    };

    // 오류 파싱 헬퍼
    const parseGeminiError = (rawText, status) => {
      let errMsg = `Gemini API 오류 (${status})`;
      try { errMsg = JSON.parse(rawText).error?.message || errMsg; } catch { errMsg = rawText.slice(0, 300) || errMsg; }
      const retryMatch = rawText.match(/retry in ([\d.]+)s/i);
      const retryAfter = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 65;
      return { errMsg, retryAfter };
    };

    // ── 비스트리밍 (OCR / 텍스트 추출용) ──
    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });

      const resText = await apiRes.text();
      if (!apiRes.ok) {
        const { errMsg, retryAfter } = parseGeminiError(resText, apiRes.status);
        return res.status(apiRes.status).json({ error: { message: errMsg }, retryAfter });
      }

      let text = '';
      try {
        const data = JSON.parse(resText);
        text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      } catch {}

      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    // ── 스트리밍 (분석용) ──
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      const { errMsg, retryAfter } = parseGeminiError(errText, apiRes.status);
      return res.status(apiRes.status).json({ error: { message: errMsg }, retryAfter });
    }

    // SSE 스트리밍 응답
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
        const lines = buf.split('\n');
        buf = lines.pop(); // 마지막 불완전한 줄 보존

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
            if (text) {
              // Anthropic content_block_delta 형식으로 변환 (index.html 파서 호환)
              res.write(`data: ${JSON.stringify({
                type: 'content_block_delta',
                delta: { type: 'text_delta', text }
              })}\n\n`);
            }
          } catch {}
        }
      }
    } catch {
      // 스트리밍 중 연결 끊김 등 — 헤더 이미 전송됐으므로 조용히 종료
    } finally {
      res.end();
    }

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: e.message || '서버 오류' } });
    }
  }
}
