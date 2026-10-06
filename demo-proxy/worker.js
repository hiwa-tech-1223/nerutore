/**
 * ねるトレ 公開デモ用の中継サーバー（Cloudflare Worker）
 *
 * デモページからのAIの呼び出しだけを、こちらのOpenAIキーを付けて中継する。
 * キーはWorkerのシークレット（OPENAI_API_KEY）に置き、ブラウザには一切渡さない。
 *
 * 使いすぎを防ぐため、次の制限をかけている。
 *   ・デモページ以外からの呼び出しは断る（Origin の照合）
 *   ・中継するのはアプリが使う3つのエンドポイントだけ
 *   ・使えるモデルを限定する
 *   ・1日あたりの回数を、IPごと・全体ごとに制限する（KV に数える）
 */

const ALLOWED_ORIGINS = [
  'https://hiwa-tech-1223.github.io',
  'http://localhost:8000',
  'http://localhost:8791',
];

const ALLOWED_PATHS = [
  '/v1/chat/completions',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
];

const ALLOWED_MODELS = ['gpt-4.1', 'gpt-5.4', 'gpt-4o-mini-tts', 'gpt-4o-mini-transcribe'];

const LIMIT_PER_IP_PER_DAY = 40;    // ひとり1日あたりの呼び出し回数（1週間分の整理で約10回使う）
const LIMIT_TOTAL_PER_DAY  = 600;   // 全体で1日あたりの呼び出し回数
const MAX_BODY_BYTES       = 300 * 1024;
const MAX_COMPLETION_TOKENS = 6000;

// 許可するヘッダーは、ブラウザが聞いてきたものをそのまま返す
// （OpenAIのSDKは x-stainless-… などの独自ヘッダーを付けるため）
const corsHeaders = (origin, requestedHeaders) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': requestedHeaders || 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const deny = (status, message, origin) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin || '*') },
  });

/** 1日ごとの回数を数える。上限を超えていたら false を返す */
async function underLimit(kv, key, limit) {
  if (!kv) return true;                       // KV を設定していないときは数えない
  const today = new Date().toISOString().slice(0, 10);
  const name = `${key}:${today}`;
  const count = Number(await kv.get(name)) || 0;
  if (count >= limit) return false;
  await kv.put(name, String(count + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.includes(origin)) return deny(403, 'このページからは利用できません', origin);
      return new Response(null, { status: 204, headers: corsHeaders(origin, request.headers.get('Access-Control-Request-Headers')) });
    }
    if (request.method !== 'POST') return deny(405, 'POST のみ受け付けます', origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return deny(403, 'このページからは利用できません', origin);
    if (!ALLOWED_PATHS.includes(url.pathname)) return deny(404, '利用できない呼び出しです', origin);

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return deny(413, '送信された内容が大きすぎます', origin);

    // JSON の呼び出しは、モデルと上限トークン数を確認する（音声の文字起こしは multipart なので対象外）
    const contentType = request.headers.get('Content-Type') || '';
    let forwardBody = body;
    if (contentType.includes('application/json')) {
      let payload;
      try { payload = JSON.parse(new TextDecoder().decode(body)); }
      catch (e) { return deny(400, '内容を読み取れませんでした', origin); }
      if (!ALLOWED_MODELS.includes(payload.model)) return deny(400, 'このモデルは利用できません', origin);
      if (payload.max_completion_tokens > MAX_COMPLETION_TOKENS) payload.max_completion_tokens = MAX_COMPLETION_TOKENS;
      if (payload.max_tokens > MAX_COMPLETION_TOKENS) payload.max_tokens = MAX_COMPLETION_TOKENS;
      payload.stream = false;
      forwardBody = JSON.stringify(payload);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!(await underLimit(env.DEMO_LIMITS, 'total', LIMIT_TOTAL_PER_DAY)))
      return deny(429, '本日のデモの上限に達しました。明日またお試しください', origin);
    if (!(await underLimit(env.DEMO_LIMITS, `ip:${ip}`, LIMIT_PER_IP_PER_DAY)))
      return deny(429, '本日の利用回数の上限に達しました。明日またお試しください', origin);

    const upstream = await fetch(`https://api.openai.com${url.pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body: forwardBody,
    });

    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
