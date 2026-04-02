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
    const { apiKey, system, messages } = body;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'API Key가 없습니다.' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Anthropic messages 형식 → Gemini contents 형식 변환
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }])
        .map(part => {
          if (part.type === 'text') return { text: part.text };
          if (part.type === 'image') return {
            inlineData: {
              mimeType: part.source.media_type,
              data: part.source.data,
            }
          };
          return { text: '' };
        })
    }));

    const geminiBody = {
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: {
        maxOutputTokens: 16000,
        temperature: 0.7,
      },
    };

    // Gemini 2.0 Flash — 무료 티어, v1beta 안정 지원
    const model = 'gemini-2.0-flash-lite';
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

    // Gemini SSE → Anthropic SSE 형식으로 변환해서 전달
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
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
                const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  // Anthropic delta 형식으로 변환
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

    return new Response(stream, {
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
