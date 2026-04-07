// Vercel Node.js Function - 최대 300초 (OCR + 재시도 대기 충분)
export const config = { maxDuration: 300 };

// quota 오류 시 재시도 (최대 3회)
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    if (res.status === 429 && attempt < maxRetries - 1) {
      let waitMs = (attempt + 1) * 12000;
      try {
        const errText = await res.text();
        const match = errText.match(/retry in ([\d.]+)s/i);
        if (match) waitMs = Math.ceil(parseFloat(match[1])) * 1000 + 1000;
      } catch {}
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { apiKey, system, messages, stream = true } = body;

    if (!apiKey) {
      return res.status(400).json({ error: { message: 'API Key가 없습니다.' } });
    }

    // Anthropic parts → Gemini parts 변환
    const allParts = [];
    for (const msg of messages) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content }];

      for (const part of content) {
        if (part.type === 'text') {
          const prev = allParts[allParts.length - 1];
          if (prev && prev.text !== undefined && !prev._afterImage) {
            prev.text += '\n' + part.text;
          } else {
            allParts.push({ text: part.text, _afterImage: false });
          }
        } else if (part.type === 'image') {
          allParts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
          allParts.push({ text: '', _afterImage: true });
        } else if (part.type === 'document') {
          allParts.push({ inlineData: { mimeType: 'application/pdf', data: part.source.data } });
          allParts.push({ text: '', _afterImage: true });
        }
      }
    }

    const cleanParts = allParts
      .map(p => {
        if (p.inlineData) return p;
        const { _afterImage, ...rest } = p;
        return rest;
      })
      .filter(p => p.inlineData || (p.text && p.text.trim()));

    const model = 'gemini-2.5-flash-lite';
    const generationConfig = stream
      ? { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 }
      : { maxOutputTokens: 8000,  temperature: 0.4, topP: 0.95, topK: 40 };

    const geminiBody = {
      contents: [{ role: 'user', parts: cleanParts }],
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig,
    };

    // ── 비스트리밍 (OCR용) ──
    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const apiRes = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
      const resText = await apiRes.text();
      if (!apiRes.ok) {
        let errMsg = 'Gemini API 오류';
        try { errMsg = JSON.parse(resText).error?.message || errMsg; } catch {}
        return res.status(apiRes.status).json({ error: { message: errMsg } });
      }
      let text = '';
      try {
        const data = JSON.parse(resText);
        text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      } catch {}
      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    // ── 스트리밍 ──
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const apiRes = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      let errMsg = 'Gemini API 오류';
      try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch { errMsg = errText.slice(0, 200) || errMsg; }
      return res.status(apiRes.status).json({ error: { message: errMsg } });
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
        if (done) {
          res.write('data: [DONE]\n\n');
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
            if (text) {
              const out = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
              res.write(`data: ${out}\n\n`);
            }
          } catch {}
        }
      }
    } catch (e) {
      // 스트리밍 중 오류 - 이미 헤더 전송됐으므로 조용히 종료
    } finally {
      res.end();
    }

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: { message: e.message } });
    }
  }
}
