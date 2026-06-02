import jwt from 'jsonwebtoken';

const _rateLimitMap        = new Map(); // login/recuperación: 5/15min
const _rateLimitPortalMap  = new Map(); // portal acudiente: 20/15min
const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 min

function getRateLimitIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';
}

function _checkLimit(map, max, ip, res) {
  const now = Date.now();
  const rec = map.get(ip);
  if (rec) {
    if (now < rec.resetAt) {
      if (rec.count >= max) {
        const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(retryAfter/60)} min.` });
        return false;
      }
      rec.count++;
    } else {
      map.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    }
  } else {
    map.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
  }
  return true;
}

export function checkRateLimit(req, res) {
  return _checkLimit(_rateLimitMap, RATE_LIMIT_MAX, getRateLimitIP(req), res);
}

export function checkRateLimitPortal(req, res, doc) {
  const key = `${getRateLimitIP(req)}:${doc || 'unknown'}`;
  return _checkLimit(_rateLimitPortalMap, 10, key, res);
}

export function verifyToken(req) {
  const _JWT_SECRET = process.env.JWT_SECRET;
  if (!_JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET env var no está definida.');
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const payload = jwt.verify(token, _JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export function requireRole(user, ...roles) {
  // Rector inherits admin read access — expand role list automatically
  const effective = roles.includes('admin') && !roles.includes('rector')
    ? [...roles, 'rector']
    : roles;
  if (!effective.includes(user.role)) throw { status: 403, message: 'No tienes permiso para esta acción' };
}

export function todayCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split('T')[0];
}

export function dayOfWeekCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  const jsDay = d.getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}
