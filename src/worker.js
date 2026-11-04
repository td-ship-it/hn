// Cloudflare Worker: phục vụ giao diện tĩnh (public/) và proxy API sang Apps Script (Google Sheet).
// Secrets cần đặt: ADMIN_PASSWORD, GAS_URL, GAS_SECRET

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function isAdmin(req, env) {
  const pw = req.headers.get('X-Admin-Password') || '';
  return !!env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD);
}

async function callGas(env, payload) {
  if (!env.GAS_URL || !env.GAS_SECRET) {
    return { ok: false, error: 'Chưa cấu hình GAS_URL / GAS_SECRET.' };
  }
  let res;
  try {
    res = await fetch(env.GAS_URL, {
      method: 'POST',
      // text/plain tránh preflight CORS với Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret: env.GAS_SECRET }),
      redirect: 'follow'
    });
  } catch (e) {
    return { ok: false, error: 'Không gọi được GAS_URL (' + (e && e.message ? e.message : e) + '). Kiểm tra lại URL.' };
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: 'Apps Script trả về không phải JSON (HTTP ' + res.status + '). Kiểm tra: URL phải kết thúc /exec, ' +
        'quyền truy cập "Bất kỳ ai", và đã triển khai phiên bản mới sau khi sửa code.'
    };
  }
}

async function readBody(req) {
  try { return await req.json(); } catch (e) { return {}; }
}

async function handleApi(req, env, path) {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await readBody(req);

  // --- Kiosk ---
  if (path === '/api/checkin') {
    const phone = String(body.phone || '').slice(0, 20);
    const r = await callGas(env, { action: 'checkIn', phone });
    if (r.error) return json({ ok: false, message: 'Hệ thống đang bận, vui lòng thử lại.', detail: String(r.error) }, 502);
    return json(r);
  }

  // --- Admin ---
  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(req, env)) return json({ error: 'Sai mật khẩu quản trị.' }, 401);
    let r;
    switch (path) {
      case '/api/admin/login':   return json({ ok: true });
      case '/api/admin/stats':   r = await callGas(env, { action: 'stats' }); break;
      case '/api/admin/present': r = await callGas(env, { action: 'setPresent', row: Number(body.row), present: !!body.present }); break;
      case '/api/admin/closed':  r = await callGas(env, { action: 'setClosed', closed: !!body.closed }); break;
      case '/api/admin/resend':  r = await callGas(env, { action: 'resend' }); break;
      default: return json({ error: 'Not found' }, 404);
    }
    if (r.error) return json({ error: r.error }, 502);
    return json(r);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url.pathname);
      } catch (e) {
        return json({ error: 'Lỗi máy chủ: ' + (e && e.message ? e.message : e) }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  }
};
