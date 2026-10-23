const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const HCAPTCHA_SECRET = Deno.env.get('HCAPTCHA_SECRET') ?? '';
const HCAPTCHA_SITEKEY = Deno.env.get('HCAPTCHA_SITEKEY') ?? '';
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://arch2kx.github.io')
  .split(',')
  .map(o => o.trim())
  .filter(o => o !== '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASSTHROUGH_ERRORS = new Set([
  'unknown_session',
  'game_not_over',
  'score_too_low',
  'invalid_name',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Vary': 'Origin',
  };
  if (origin !== null && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

async function verifyCaptcha(token: string, ip: string | null): Promise<boolean> {
  const params = new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token });
  if (HCAPTCHA_SITEKEY !== '') params.set('sitekey', HCAPTCHA_SITEKEY);
  if (ip !== null) params.set('remoteip', ip);

  const res = await fetch('https://api.hcaptcha.com/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, origin);
  if (origin === null || !ALLOWED_ORIGINS.includes(origin)) return json(403, { error: 'forbidden' }, origin);
  if (HCAPTCHA_SECRET === '' || SERVICE_ROLE_KEY === '') return json(500, { error: 'not_configured' }, origin);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_json' }, origin);
  }

  const { session_id, name, captcha } = (body ?? {}) as Record<string, unknown>;
  if (typeof session_id !== 'string' || typeof name !== 'string' || typeof captcha !== 'string') {
    return json(400, { error: 'bad_input' }, origin);
  }
  if (!UUID_RE.test(session_id)) return json(400, { error: 'unknown_session' }, origin);
  if (name.length > 200) return json(400, { error: 'invalid_name' }, origin);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  let captchaOk = false;
  try {
    captchaOk = await verifyCaptcha(captcha, ip);
  } catch {
    return json(502, { error: 'captcha_unavailable' }, origin);
  }
  if (!captchaOk) return json(403, { error: 'captcha_failed' }, origin);

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_score`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_session_id: session_id, p_name: name }),
    });
  } catch {
    return json(502, { error: 'submit_failed' }, origin);
  }

  if (!res.ok) {
    let code = '';
    try {
      const err = (await res.json()) as { message?: unknown };
      if (typeof err.message === 'string') code = err.message;
    } catch {}
    if (code === 'rate_limited') return json(429, { error: 'rate_limited' }, origin);
    if (PASSTHROUGH_ERRORS.has(code)) return json(400, { error: code }, origin);
    return json(500, { error: 'submit_failed' }, origin);
  }

  const data = (await res.json()) as { id?: unknown; rank?: unknown };
  return json(200, { id: Number(data.id), rank: Number(data.rank) }, origin);
});
