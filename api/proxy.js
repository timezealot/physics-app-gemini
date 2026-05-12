// Vercel Node.js Function — OpenRouter 버전
export const config = { maxDuration: 300 };

// 선호 모델 순서 (2026년 5월 기준, OCR 성능 우선)
const PREFERRED_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free', // 1순위: OCRBench v2 1위, 손글씨 특화
  'google/gemma-4-26b-a4b-it:free',    // 2순위: 빠름, 비전 지원
  'google/gemma-4-31b-it:free',        // 3순위
  'openrouter/free',                   // 최후 fallback
];

// 실시간으로 현재 사용 가능한 무료 비전 모델 조회
async function getAvailableVisionModel(key) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const freeVisionModels = (data.data || []).filter(m =>
      m.pricing?.prompt === '0' &&
      m.architecture?.input_modalities?.includes('image')
    ).map(m => m.id);
    for (const preferred of PREFERRED_MODELS) {
      if (freeVisionModels.includes(preferred)) return preferred;
    }
    return freeVisionModels[0] || null;
  } catch {
    return null;
  }
}

// 단일 모델 호출
async function callModel(key, model, orMessages, max_tokens) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 230000);
  try {
    const apiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'https://physics-analyzer.vercel.app',
        'X-Title': 'Physics Analyzer',
      },
      body: JSON.stringify({ model, messages: orMessages, max_tokens, temperature: 0, top_p: 1.0 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return { apiRes, timedOut: false };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') return { apiRes: null, timedOut: true };
    throw err;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { apiKey, system, messages, model: reqModel } = body;

    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(400).json({ error: { message: 'OpenRouter API Key 없음' } });
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: { message: 'messages 형식 오류' } });

    // Anthropic → OpenAI 형식 변환
    const orMessages = [];
    if (system) orMessages.push({ role: 'system', content: system });

    for (const msg of messages) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content || '') }];
      const orContent = [];
      for (const part of content) {
        if (part.type === 'text') {
          orContent.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image') {
          const mediaType = part.source?.media_type || 'image/jpeg';
          const data = part.source?.data || '';
          orContent.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
        } else if (part.type === 'document') {
          orContent.push({ type: 'text', text: '[PDF 첨부]' });
        }
      }
      orMessages.push({ role: msg.role || 'user', content: orContent });
    }

    // 시도할 모델 목록 구성
    const modelsToTry = [];
    if (reqModel && PREFERRED_MODELS.includes(reqModel)) modelsToTry.push(reqModel);
    for (const m of PREFERRED_MODELS) {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
    }

    let lastErrMsg = '사용 가능한 모델이 없습니다.';
    let lastStatus = 503;
    let dynamicAdded = false;

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = modelsToTry[i];
      const { apiRes, timedOut } = await callModel(key, model, orMessages, 8000);

      if (timedOut) {
        lastErrMsg = '응답 시간이 너무 깁니다.';
        if (!dynamicAdded) {
          dynamicAdded = true;
          const dynamic = await getAvailableVisionModel(key);
          if (dynamic && !modelsToTry.includes(dynamic)) modelsToTry.push(dynamic);
        }
        continue;
      }

      const resText = await apiRes.text();

      if (!apiRes.ok) {
        let errMsg = `OpenRouter 오류 (${apiRes.status})`;
        let retryAfter = 30;
        try {
          const j = JSON.parse(resText);
          errMsg = j.error?.message || errMsg;
          const ra = apiRes.headers.get('retry-after');
          if (ra) retryAfter = parseInt(ra) + 2;
        } catch { errMsg = resText.slice(0, 200) || errMsg; }

        const isNoEndpoint = errMsg.toLowerCase().includes('no endpoints') ||
                             errMsg.toLowerCase().includes('not found') ||
                             apiRes.status === 404;
        const isQuota = apiRes.status === 429;
        const isOverload = apiRes.status === 503;

        if (isNoEndpoint) {
          // 모델 없음 → 다음으로 자동 전환
          lastErrMsg = errMsg; lastStatus = apiRes.status;
          if (!dynamicAdded && i >= modelsToTry.length - 2) {
            dynamicAdded = true;
            const dynamic = await getAvailableVisionModel(key);
            if (dynamic && !modelsToTry.includes(dynamic)) modelsToTry.push(dynamic);
          }
          continue;
        }

        if (isQuota) {
          // 일일 한도(daily) vs 분당 한도(RPM) 구분
          const isDaily = errMsg.toLowerCase().includes('daily limit') ||
                          errMsg.toLowerCase().includes('daily quota') ||
                          errMsg.toLowerCase().includes('per day') ||
                          errMsg.toLowerCase().includes('하루') ||
                          retryAfter > 3600; // 1시간 이상이면 일일 한도로 간주 (RPM은 보통 60초 이하)
          if (isDaily) {
            // 일일 한도: 다른 모델로 바꿔도 소용없음 → 즉시 안내
            return res.status(429).json({
              error: { message: '오늘 무료 사용량(200회)을 모두 소진했습니다. 내일 자정(UTC)에 초기화됩니다.' },
              retryAfter: 86400,
              isDailyLimit: true,
            });
          }
          // RPM 초과: 다음 모델로 자동 전환
          lastErrMsg = errMsg; lastStatus = apiRes.status;
          if (!dynamicAdded && i >= modelsToTry.length - 2) {
            dynamicAdded = true;
            const dynamic = await getAvailableVisionModel(key);
            if (dynamic && !modelsToTry.includes(dynamic)) modelsToTry.push(dynamic);
          }
          continue;
        }

        if (isOverload) {
          // 503: 서버 과부하 → 다음 모델로 자동 전환
          lastErrMsg = errMsg; lastStatus = apiRes.status;
          continue;
        }

        lastErrMsg = errMsg; lastStatus = apiRes.status;
        continue;
      }

      // 성공 - 빈 응답이면 다음 모델 시도
      let text = '';
      try {
        const d = JSON.parse(resText);
        text = d.choices?.[0]?.message?.content || '';
      } catch {}
      if (!text || text.trim().length < 5) {
        // 빈 응답 → 다음 모델로
        lastErrMsg = '빈 응답 수신'; lastStatus = 500;
        continue;
      }
      return res.status(200).json({ content: [{ type: 'text', text }] });
    }

    // 전부 실패
    return res.status(lastStatus).json({ error: { message: `모든 모델 시도 실패. 잠시 후 다시 시도해 주세요.` }, retryAfter: 30 });

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: { message: e.message || '서버 오류' } });
  }
}
