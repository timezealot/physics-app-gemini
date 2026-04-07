export const config = { runtime: 'edge' };

// quota 오류 시 재시도 (최대 3회, 지수 백오프)
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    // quota 초과(429)면 retry-after 또는 기본 대기 후 재시도
    if (res.status === 429) {
      if (attempt < maxRetries - 1) {
        let waitMs = (attempt + 1) * 12000; // 12s, 24s, 36s
        try {
          const errJson = await res.clone().json();
          const msg = errJson?.error?.message || '';
          const match = msg.match(/retry in ([\d.]+)s/i);
          if (match) waitMs = Math.ceil(parseFloat(match[1])) * 1000 + 1000;
        } catch {}
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    }
    return res; // 다른 오류는 그대로 반환
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    const body = await req.json();
    const { apiKey, system, messages, stream = true } = body;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'API Key가 없습니다.' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
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
          allParts.push({
            inlineData: {
              mimeType: part.source.media_type,
              data: part.source.data,
            }
          });
          allParts.push({ text: '', _afterImage: true });
        } else if (part.type === 'document') {
          // PDF document — Gemini natively supports PDF
          allParts.push({
            inlineData: {
              mimeType: 'application/pdf',
              data: part.source.data,
            }
          });
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

    // 스트리밍/비스트리밍에 따라 설정 분리
    // OCR(비스트리밍): temperature 약간 높여서 반복 루프 방지
    // 분석(스트리밍): temperature 낮게 유지
    const generationConfig = stream
      ? { maxOutputTokens: 16000, temperature: 0.2, topP: 0.95, topK: 40 }
      : { maxOutputTokens: 8000,  temperature: 0.4, topP: 0.95, topK: 40 };

    const geminiBody = {
      contents: [{ role: 'user', parts: cleanParts }],
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig,
    };

    // ── 비스트리밍 모드 (OCR용) ──
    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
      if (!res.ok) {
        const errText = await res.text();
        let errMsg = 'Gemini API 오류';
        try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch {}
        return new Response(JSON.stringify({ error: { message: errMsg } }), {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      return new Response(JSON.stringify({
        content: [{ type: 'text', text }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // ── 스트리밍 모드 ──
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = 'Gemini API 오류';
      try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch {}
      return new Response(JSON.stringify({ error: { message: errMsg } }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const streamResp = new ReadableStream({
      async start(controller) {
        let buf = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
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
                  const out = JSON.stringify({
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text }
                  });
                  controller.enqueue(encoder.encode(`data: ${out}\n\n`));
                }
              } catch {}
            }
          }
        } catch (e) {
          controller.error(e);
        }
      }
    });

    return new Response(streamResp, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
