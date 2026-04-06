export const config = { runtime: 'edge' };

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

    const geminiBody = {
      contents: [{ role: 'user', parts: cleanParts }],
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: {
        maxOutputTokens: 16000,
        temperature: 0,
        topP: 0.95,
        topK: 40,
      },
    };

    const model = 'gemini-2.5-flash-lite';

    // ── 비스트리밍 모드 (OCR용) ──
    if (!stream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
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
      // Anthropic 형식으로 반환
      return new Response(JSON.stringify({
        content: [{ type: 'text', text }]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // ── 스트리밍 모드 ──
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await fetch(url, {
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
