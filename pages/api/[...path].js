import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};


let supabase = null;

function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return supabase;
}

const _JWT_SECRET = process.env.JWT_SECRET;
if (!_JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET env var no está definida. Configúrala en Vercel antes de desplegar.');
}

// Filtra queries por sede del usuario. superadmin y rector ven todo.
function sedeScope(query, user) {
  if (!user || user.role === 'superadmin' || user.role === 'rector') return query;
  // Admin (coordinador): puede tener varias sedes vía raice_user_sedes
  if (user.role === 'admin') {
    if (user.sede_ids && user.sede_ids.length > 0) return query.in('sede_id', user.sede_ids);
    return query.in('sede_id', ['00000000-0000-0000-0000-000000000000']); // admin sin sedes asignadas: restringido
  }
  // Teacher/otros: una sola sede
  if (user.sede_id) return query.eq('sede_id', user.sede_id);
  return query;
}

// =====================================================
// MAIN HANDLER
// =====================================================
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS — only allow configured origin; never fall back to wildcard
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const requestOrigin = req.headers['origin'] || '';
  if (allowedOrigin) {
    // Exact match against configured origin
    if (requestOrigin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    }
    // If no match, we simply don't set the header — browser will block the request
  } else {
    // No ALLOWED_ORIGIN configured → only allow same-origin (no cross-origin header)
    // This is safe: Vercel serves frontend and API from the same domain
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  // Prevent authenticated responses from being stored in any cache (browser, CDN, proxy)
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Health check
  if (url.pathname === '/api/health') return res.status(200).json({ ok: true, system: 'RAICE', ts: new Date().toISOString() });

  // Keep-alive ping — called by Vercel cron every 3 days to prevent Supabase free-tier pause
  if (url.pathname === '/api/ping') {
    const sb = getSupabase();
    await sb.from('raice_config').select('id').eq('id', 1).maybeSingle().catch(() => null);
    return res.status(200).json({ ok: true, ts: new Date().toISOString() });
  }

  const pathParts = url.pathname.replace('/api/', '').split('/').filter(Boolean);

  try {
    // PUBLIC routes (no auth required)
    if (pathParts[0] === 'auth' && pathParts[1] === 'login') return await login(req, res);
    if (pathParts[0] === 'raice' && pathParts[1] === 'acudientes' &&
        (req.headers['authorization']?.startsWith('Bearer ') || new URL(req.url, `http://${req.headers.host}`).searchParams.get('token'))
    ) return await handleAcudientes(req, res, null);
    if (pathParts[0] === 'raice' && pathParts[1] === 'recover-password') return await recoverPassword(req, res);
    if (pathParts[0] === 'raice' && pathParts[1] === 'portal-acudiente') return await handlePortalAcudiente(req, res);
    // Cron uses its own Bearer CRON_SECRET auth (not JWT) — must be before verifyToken
    if (pathParts[0] === 'raice' && pathParts[1] === 'cron' && pathParts[2] === 'weekly-report') return await cronWeeklyReport(req, res);

    // PROTECTED routes
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });

    // Rector is read-only: block all non-GET methods globally
    if (user.role === 'rector' && req.method !== 'GET') {
      return res.status(403).json({ error: 'El rector solo tiene acceso de lectura. Esta acción no está permitida.' });
    }

    const route = pathParts.join('/');

    // ---- SUPERADMIN & ADMIN routes ----
    if (route === 'raice/sedes')                return await handleSedes(req, res, user);
    if (route === 'raice/dashboard')            return await getDashboardV2(req, res, user);
    if (route === 'raice/alerts')               return await getAlertsEndpoint(req, res, user);
    if (route === 'raice/users')                return await handleUsers(req, res, user);
    if (route === 'raice/users/reset-password') return await resetUserPassword(req, res, user);
    if (route === 'raice/students')             return await handleStudents(req, res, user);
    if (route === 'raice/students/import')      return await importStudents(req, res, user);
    if (route === 'raice/simat/preview')        return await simatPreview(req, res, user);
    if (route === 'raice/simat/import')         return await simatImport(req, res, user);
    if (route === 'raice/teachers')             return await handleTeachers(req, res, user);
    if (route === 'raice/courses')              return await handleCourses(req, res, user);
    if (route === 'raice/subgroup-members')     return await handleSubgroupMembers(req, res, user);
    if (route === 'raice/cases')                return await handleCases(req, res, user);
    if (route === 'raice/faltas-catalogo')      return await handleFaltasCatalogo(req, res, user);
    if (route === 'raice/tipo1-escalones')      return await handleTipo1Escalones(req, res, user);
    if (route === 'raice/excusas/cleanup-orphaned') return await cleanupOrphanedPE(req, res, user);
    if (route === 'raice/excusas')               return await handleExcusas(req, res, user);
    if (route === 'raice/cases/status')         return await updateCaseStatus(req, res, user);
    if (route === 'raice/cases/followup')       return await saveCaseFollowup(req, res, user);
    if (route === 'raice/cases/report')         return await getCasesReport(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='cases' && pathParts[2]) return await getCaseDetail(req, res, user);
    if (route === 'raice/commitments')          return await handleCommitments(req, res, user);
    if (route === 'raice/commitments/fulfill')  return await fulfillCommitment(req, res, user);
    if (route === 'raice/attendance')           return await handleAttendance(req, res, user);
    if (route === 'raice/register-omission')   return await handleRegisterOmission(req, res, user);
    if (route === 'raice/config')               return await handleConfig(req, res, user);
    if (route === 'raice/realtime-config')       return await handleRealtimeConfig(req, res, user);
    if (route === 'raice/config/security')      return await handleSecurityConfig(req, res, user);
    if (route === 'raice/logs')                 return await handleLogs(req, res, user);
    if (route === 'raice/purge')                return await handlePurge(req, res, user);
    if (route === 'raice/backup/export')        return await handleBackupExport(req, res, user);
    if (route === 'raice/backup/csv')           return await handleBackupCsv(req, res, user);
    if (route === 'raice/backup/send-email')    return await handleBackupEmail(req, res, user);
    if (route === 'raice/backup/import')        return await handleBackupImport(req, res, user);
    if (route === 'raice/cron/weekly-report')   return res.status(200).json({ ok: true, message: 'El reporte semanal se genera automáticamente. Revisa el email configurado.' });
    if (route === 'raice/tardanzas')            return await getTardanzasReport(req, res, user);
    if (route === 'raice/search')               return await globalSearch(req, res, user);
    if (route === 'raice/student-ficha')        return await getStudentFicha(req, res, user);
    if (route === 'raice/rector-insights')     return await getRectorInsights(req, res, user);
    if (route === 'raice/acudientes')           return await handleAcudientes(req, res, user);
    if (route === 'raice/calendar/today')       return await handleCalendarToday(req, res, user);
    if (route === 'raice/calendar/range')       return await handleCalendarRange(req, res, user);
    if (route === 'raice/calendar')             return await handleCalendar(req, res, user);
    if (route === 'raice/reports/attendance')   return await reportAttendance(req, res, user);
    if (route === 'raice/reports/attendance-v2') return await reportAttendanceV2(req, res, user);
    if (route === 'raice/reports/cases')        return await reportCases(req, res, user);
    if (route === 'raice/schedules/overview')   return await getSchedulesOverview(req, res, user);
    if (route === 'raice/schedules')            return await handleSchedules(req, res, user);
    if (route === 'raice/bell-schedule')        return await handleBellSchedule(req, res, user);
    if (route === 'raice/teacher-schedule')     return await getTeacherSchedule(req, res, user);
    if (route === 'raice/my-schedule')          return await getTeacherSchedule(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='student-history' && pathParts[2]) return await getStudentHistory(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='student-grade-history' && pathParts[2]) return await getStudentGradeHistory(req, res, user);

    // ---- FASE 3 routes ----
    if (route === 'raice/periods')              return await handlePeriods(req, res, user);
    if (route === 'raice/periods/sync')         return await syncPeriods(req, res, user);
    if (route === 'raice/notifications')        return await handleNotifications(req, res, user);
    if (route === 'raice/citations')            return await handleCitations(req, res, user);
    if (route === 'raice/stats/period')         return await getStatsByPeriod(req, res, user);
    if (route === 'raice/teacher-courses')      return await handleTeacherCourses(req, res, user);

    if (route === 'raice/teacher-absences')                return await handleTeacherAbsences(req, res, user);
    if (route === 'raice/teacher-absences/replacement')    return await handleAbsenceReplacement(req, res, user);
    if (route === 'raice/teacher-absences/suggestions')    return await getReplacementSuggestions(req, res, user);

    // ---- FASE 4 routes ----
    if (route === 'raice/classroom-removals')    return await handleClassroomRemovals(req, res, user);
    if (route === 'raice/suspensions')           return await handleSuspensions(req, res, user);
    if (route === 'raice/attendance/unlock')     return await unlockAttendance(req, res, user);
    if (route === 'raice/attendance/missing')    return await getMissingAttendance(req, res, user);

    // ---- TEACHER-SPECIFIC routes ----
    if (route === 'raice/course-day-schedule')  return await getCourseDaySchedule(req, res, user);
    if (route === 'raice/my-courses')           return await getMyCourses(req, res, user);
    if (route === 'raice/attendance/course')    return await getAttendanceByCourse(req, res, user);
    if (route === 'raice/attendance/range')     return await getAttendanceRange(req, res, user);
    if (route === 'raice/observations')         return await handleObservations(req, res, user);
    if (route === 'raice/my-cases')             return await getMyCases(req, res, user);
    if (route === 'raice/change-password')      return await changePassword(req, res, user);
    if (route === 'raice/grade-cases')          return await getGradeCases(req, res, user);
    if (route === 'raice/evasions')             return await getEvasions(req, res, user);
    if (route === 'raice/evasions/resolve')     return await resolveEvasion(req, res, user);
    if (route === 'raice/year-rollover')        return await handleYearRollover(req, res, user);

    return res.status(404).json({ error: 'Ruta no encontrada' });
  } catch (err) {
    // requireRole throws { status, message } — respect the status code
    if (err && err.status && err.message) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('RAICE API Error:', err?.message, err?.stack);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Helper: log DB error server-side, return a safe generic string to the client
function _dbErr(error, context = '') {
  if (error) console.error(`[RAICE DB${context ? ' ' + context : ''}]`, error.message);
  return 'Error interno del servidor';
}

// =====================================================
// RATE LIMITING (in-memory, per-IP)
// Max 5 attempts per 15 minutes on sensitive endpoints
// =====================================================
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

function checkRateLimit(req, res) {
  return _checkLimit(_rateLimitMap, RATE_LIMIT_MAX, getRateLimitIP(req), res);
}

function checkRateLimitPortal(req, res, doc) {
  const key = `${getRateLimitIP(req)}:${doc || 'unknown'}`;
  return _checkLimit(_rateLimitPortalMap, 10, key, res);
}

// =====================================================
// AUTH
// =====================================================

async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!checkRateLimit(req, res)) return;

  const sb = getSupabase();
  const { username, password, role } = req.body || {};

  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  // Find user by username (no DB-level join for raice_sedes to avoid schema cache / missing constraint errors)
  const { data: user, error } = await sb
    .from('raice_users')
    .select('id, username, first_name, last_name, email, role, subject, sede_id, password_hash, active, must_change_password')
    .eq('username', username.toLowerCase().trim())
    .single();

  if (error || !user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  if (!user.active)   return res.status(403).json({ error: 'Cuenta desactivada. Contacta al coordinador.' });

  // Role mismatch check
  if (role && user.role !== role) {
    const labels = { superadmin:'Superadministrador', admin:'Coordinador', teacher:'Docente', rector:'Rector' };
    return res.status(401).json({ error: `Este usuario no tiene perfil de ${labels[role] || role}` });
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  // Update last login
  await sb.from('raice_users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

  // Log activity
  await logActivity(sb, user.id, 'login', `Inicio de sesión: @${user.username}`);

  // Fetch teacher's sede name separately in memory (avoids DB join)
  let single_sede_name = null;
  if (user.role === 'teacher' && user.sede_id) {
    try {
      const { data: sd } = await sb.from('raice_sedes').select('name').eq('id', user.sede_id).maybeSingle();
      if (sd) single_sede_name = sd.name;
    } catch (_) {}
  }

  // Cargar sedes del coordinador (admin puede tener varias; rector/superadmin ven todo)
  let sede_ids   = null;
  let sede_names = null;
  if (user.role === 'admin') {
    try {
      const { data: userSedes } = await sb
        .from('raice_user_sedes')
        .select('sede_id')
        .eq('user_id', user.id);
      if (userSedes && userSedes.length > 0) {
        sede_ids   = userSedes.map(s => s.sede_id);
        const { data: sList } = await sb.from('raice_sedes').select('id, name').in('id', sede_ids);
        const sMap = {};
        (sList || []).forEach(s => { sMap[s.id] = s.name; });
        sede_names = sede_ids.map(sid => sMap[sid]).filter(Boolean);
      }
    } catch (_) { /* tabla aún no migrada — se ignora */ }
  }

  // Generate token
  const token = jwt.sign(
    {
      id: user.id, role: user.role, username: user.username,
      // Teachers: single sede_id. Admins: sede_ids array. Rector/superadmin: null
      sede_id:  user.role === 'teacher' ? (user.sede_id || null) : null,
      sede_ids: user.role === 'admin'   ? (sede_ids || [])       : null,
    },
    _JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.status(200).json({
    success: true,
    token,
    role: user.role,
    user: {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name:  user.last_name,
      name: `${user.first_name} ${user.last_name}`,
      role:  user.role,
      subject: user.subject,
      // sede_id solo para docentes; admins usan sede_ids
      sede_id:    user.role === 'teacher' ? (user.sede_id || null) : null,
      sede_name:  user.role === 'teacher' ? (single_sede_name || null)
                : (sede_names && sede_names.length > 0 ? sede_names.join(' · ') : null),
      sede_ids:   sede_ids,
      sede_names: sede_names,
      must_change_password: user.must_change_password || false
    }
  });
}

async function verifyToken(req) {
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

function requireRole(user, ...roles) {
  // Rector inherits admin read access — expand role list automatically
  const effective = roles.includes('admin') && !roles.includes('rector')
    ? [...roles, 'rector']
    : roles;
  if (!effective.includes(user.role)) throw { status: 403, message: 'No tienes permiso para esta acción' };
}

// =====================================================
// HELPERS
// =====================================================

/**
 * Returns the current date in Colombia (America/Bogota, UTC-5) as YYYY-MM-DD.
 * All "today" calculations must use this helper so the server never
 * drifts to a different date than what teachers and coordinators see.
 * @param {number} [offsetDays=0] - optional offset in days (negative = past)
 */
function todayCO(offsetDays = 0) {
  const d = offsetDays === 0
    ? new Date()
    : new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
}

/**
 * Given a YYYY-MM-DD date string, returns the day of week in Colombia timezone.
 * Returns 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
 * (matches the day_of_week values stored in raice_schedules)
 */
function dayOfWeekCO(dateStr) {
  // Parse the date at noon Colombia time to avoid any UTC day-boundary issues
  const d = new Date(new Date(`${dateStr}T12:00:00`).toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const jsDay = d.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  return jsDay === 0 ? 7 : jsDay; // convert to 1=Mon, 7=Sun
}

/**
 * Always reads sede_ids from DB for admin users — never trusts stale JWT.
 * Returns an array of sede UUIDs for the given admin user,
 * or null for roles that see everything (superadmin, rector).
 * Returns [] if the admin has no sedes assigned.
 */
// sedeFilter: UUID opcional — si el coordinador está trabajando en una sede activa
// lo pasa el cliente como ?sede_filter=UUID y se valida aquí contra sus sedes reales.
async function getAdminSedeIds(sb, user, sedeFilter = null) {
  if (user.role !== 'admin') return null; // superadmin/rector → sin restricción
  try {
    const { data: rows } = await sb
      .from('raice_user_sedes')
      .select('sede_id')
      .eq('user_id', user.id);
    const all = (rows || []).map(r => r.sede_id);
    // Si el cliente pide filtrar a una sola sede y esa sede está en la lista del admin
    if (sedeFilter && all.includes(sedeFilter)) return [sedeFilter];
    return all;
  } catch (_) {
    // tabla aún no migrada → fallback al JWT
    const all = user.sede_ids || [];
    if (sedeFilter && all.includes(sedeFilter)) return [sedeFilter];
    return all;
  }
}

async function getAllowedCourseIdsForAdmin(sb, user, sedeFilter = null) {
  if (user.role !== 'admin') return null;
  const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilter);
  if (!adminSedeIds || adminSedeIds.length === 0) return ['00000000-0000-0000-0000-000000000000'];
  const { data: courses } = await sb.from('raice_courses').select('id').in('sede_id', adminSedeIds);
  const ids = (courses || []).map(c => c.id);
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'];
}

/**
 * Sede filter for rector/superadmin — they see everything by default,
 * but can optionally narrow to one sede via ?sede_filter=UUID.
 * Returns null (no restriction) or [sedeId] array.
 */
async function getRectorSedeFilter(sedeFilter) {
  if (!sedeFilter) return null; // no filter → see everything
  return [sedeFilter];
}

/**
 * Given a sede ID array (or null for no restriction), returns course IDs for those sedes.
 */
async function getCourseIdsForSedes(sb, sedeIds) {
  if (!sedeIds) return null; // null = no restriction
  if (!sedeIds.length) return ['00000000-0000-0000-0000-000000000000'];
  const { data } = await sb.from('raice_courses').select('id').in('sede_id', sedeIds);
  const ids = (data || []).map(c => c.id);
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'];
}

async function logActivity(sb, userId, type, detail) {
  try {
    await sb.from('raice_logs').insert({ user_id: userId, event_type: type, detail });
  } catch (_) { /* silencioso */ }
}

// =====================================================
// DASHBOARD (v2 — único dashboard activo)
// =====================================================

async function getAttendanceToday(sb) {
  const today = todayCO();
  const { data } = await sb.from('raice_attendance').select('status').eq('date', today);
  if (!data || !data.length) return null;
  // Only show % if a teacher actively took list (at least one P, A or T — not just PE from excusas)
  const hasRealList = data.some(r => r.status === 'P' || r.status === 'A' || r.status === 'T');
  if (!hasRealList) return null;
  const present = data.filter(r => r.status === 'P' || r.status === 'PE').length;
  return Math.round((present / data.length) * 100);
}

async function getAlerts(sb) {
  const alerts = [];
  const today = todayCO();
  const threeDaysAgo = todayCO(-3);

  // Students with 3+ absences in a row
  let absences = [];
  try { const r = await sb.rpc('get_repeated_absences', { since_date: threeDaysAgo }); absences = r.data || []; } catch (_) {}
  (absences || []).forEach(a => alerts.push({
    type: 'absence', severity: 'medium',
    title: `${a.student_name} — ${a.count} ausencias seguidas`,
    description: `${a.grade}°${a.course} · Última: ${a.last_date}`
  }));

  // Open cases with no follow-up in 3 days
  let staleCases = [];
  try {
    const r = await sb.from('raice_cases').select('id, student_name, type, created_at')
      .eq('status', 'open').lt('created_at', threeDaysAgo).limit(5);
    staleCases = r.data || [];
  } catch (_) {}
  (staleCases || []).forEach(c => alerts.push({
    type: 'case', severity: c.type >= 2 ? 'high' : 'medium',
    title: `Caso Tipo ${c.type} sin seguimiento — ${c.student_name}`,
    description: `Abierto hace ${Math.floor((Date.now() - new Date(c.created_at)) / 86400000)} días`
  }));

  return alerts.slice(0, 8);
}

// =====================================================
// ALERTS ENDPOINT — combina alertas computadas + notificaciones no leídas
// =====================================================
async function getAlertsEndpoint(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const today        = todayCO();
  const sevenAgo     = todayCO(-7);
  const threeDaysAgo = todayCO(-3);
  const oneDayAgo    = todayCO(-1);

  // Sede scope: pre-cargar course_ids de las sedes del coordinador
  // Siempre leemos sede_ids desde la BD para evitar tokens JWT desactualizados
  const alertSedeFilter = url.searchParams.get('sede_filter');
  let sedeCourseIds = null;      // null = sin restricción (superadmin / rector sin filtro)
  let sedeGradeCourseKeys = null;
  if (user.role === 'admin') {
    const adminSedeIds = await getAdminSedeIds(sb, user, alertSedeFilter);
    if (adminSedeIds && adminSedeIds.length > 0) {
      const { data: scs } = await sb.from('raice_courses')
        .select('id, grade, number').in('sede_id', adminSedeIds).neq('type', 'subgroup');
      sedeCourseIds = (scs || []).map(c => c.id);
      sedeGradeCourseKeys = new Set((scs || []).map(c => `${c.grade}_${c.number}`));
    } else {
      sedeCourseIds = ['00000000-0000-0000-0000-000000000000'];
      sedeGradeCourseKeys = new Set();
    }
  } else if (alertSedeFilter && (user.role === 'rector' || user.role === 'superadmin')) {
    const { data: scs } = await sb.from('raice_courses')
      .select('id, grade, number').eq('sede_id', alertSedeFilter).neq('type', 'subgroup');
    sedeCourseIds = (scs || []).map(c => c.id);
    sedeGradeCourseKeys = new Set((scs || []).map(c => `${c.grade}_${c.number}`));
    if (!sedeCourseIds.length) {
      sedeCourseIds = ['00000000-0000-0000-0000-000000000000'];
      sedeGradeCourseKeys = new Set();
    }
  }

  const alerts = [];

  // ── 1. Notificaciones no leídas ──
  try {
    const { data: notifs } = await sb.from('raice_notifications')
      .select('id, type, title, body, read, created_at, link_id, from_user_id')
      .eq('to_user_id', user.id)
      .eq('read', false)
      .in('type', ['evasion', 'new_case', 'tardanza'])
      .order('created_at', { ascending: false })
      .limit(20);

    // Filter out notifications whose linked case was deleted
    const notifCaseIds = (notifs||[]).map(n => n.link_id).filter(Boolean);
    let existingCaseIds = new Set();
    if (notifCaseIds.length) {
      const { data: existingCases } = await sb.from('raice_cases')
        .select('id').in('id', notifCaseIds);
      (existingCases||[]).forEach(c => existingCaseIds.add(c.id));
      // Auto-mark orphan notifications as read so they never reappear
      const orphanIds = (notifs||[])
        .filter(n => n.link_id && !existingCaseIds.has(n.link_id))
        .map(n => n.id);
      if (orphanIds.length) {
        await sb.from('raice_notifications').update({ read: true }).in('id', orphanIds);
      }
    }
    const validNotifs = (notifs||[]).filter(n => !n.link_id || existingCaseIds.has(n.link_id));

    const fromIds = [...new Set((validNotifs||[]).map(n => n.from_user_id).filter(Boolean))];
    const fromMap = {};
    if (fromIds.length) {
      const { data: senders } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', fromIds);
      (senders||[]).forEach(s => fromMap[s.id] = `${s.first_name} ${s.last_name}`);
    }

    const typeLabels = {
      evasion:           { ico: '🏃', label: 'Posible evasión',         severity: 'high'   },
      evasion_retracted: { ico: '✅', label: 'Evasión retirada',         severity: 'low'    },
      new_case:          { ico: '⚠️', label: 'Nuevo caso RAICE',         severity: 'high'   },
      tardanza:          { ico: '⏰', label: 'Tardanza registrada',       severity: 'low'    },
    };

    (validNotifs || []).forEach(n => {
      const meta   = typeLabels[n.type] || { ico: '🔔', label: n.type, severity: 'medium' };
      const sender = fromMap[n.from_user_id] ? ` · Docente: ${fromMap[n.from_user_id]}` : '';
      const date   = n.created_at ? new Date(n.created_at).toLocaleDateString('es-CO',{day:'numeric',month:'short'}) : '';
      alerts.push({
        id: n.id, source: 'notification', type: n.type,
        severity: meta.severity, ico: meta.ico,
        title:       n.title || `${meta.ico} ${meta.label}`,
        description: `${n.body || ''}${sender}${date ? ' · '+date : ''}`,
        notif_id: n.id, link_id: n.link_id,
      });
    });
  } catch (_) {}

  // ── 2. Evasiones pendientes (sin resolver) ──
  try {
    const { data: pendingEva } = await sb.from('raice_notifications')
      .select('id, title, body, created_at, link_id, from_user_id')
      .eq('to_user_id', user.id)
      .eq('type', 'evasion')
      .gte('created_at', sevenAgo + 'T00:00:00.000Z')
      .order('created_at', { ascending: false })
      .limit(10);

    // Resolve sender names
    const evaFromIds = [...new Set((pendingEva||[]).map(n => n.from_user_id).filter(Boolean))];
    const evaFromMap = {};
    if (evaFromIds.length) {
      const { data: snd } = await sb.from('raice_users').select('id, first_name, last_name').in('id', evaFromIds);
      (snd||[]).forEach(s => evaFromMap[s.id] = `${s.first_name} ${s.last_name}`);
    }

    (pendingEva || []).forEach(n => {
      // Avoid duplicating if already in unread notifications above
      if (alerts.some(a => a.notif_id === n.id)) return;
      const date = n.created_at ? new Date(n.created_at).toLocaleDateString('es-CO',{day:'numeric',month:'short'}) : '';
      const sender = evaFromMap[n.from_user_id] ? ` · Docente: ${evaFromMap[n.from_user_id]}` : '';
      alerts.push({
        id: n.id, source: 'notification', type: 'evasion',
        severity: 'high', ico: '🏃',
        title: n.title || '🏃 Posible evasión sin resolver',
        description: `${n.body || ''}${sender}${date ? ' · '+date : ''} · ⏳ Sin confirmar`,
        notif_id: n.id, link_id: n.link_id,
      });
    });
  } catch (_) {}

  // ── 2.5. Evasiones retractadas (asistencia corregida por el docente) — no leídas ──
  try {
    const { data: retractedEva } = await sb.from('raice_notifications')
      .select('id, title, body, created_at, link_id, from_user_id')
      .eq('to_user_id', user.id)
      .eq('type', 'evasion_retracted')
      .eq('read', false)
      .gte('created_at', sevenAgo + 'T00:00:00.000Z')
      .order('created_at', { ascending: false })
      .limit(10);

    const retFromIds = [...new Set((retractedEva||[]).map(n => n.from_user_id).filter(Boolean))];
    const retFromMap = {};
    if (retFromIds.length) {
      const { data: snd } = await sb.from('raice_users').select('id, first_name, last_name').in('id', retFromIds);
      (snd||[]).forEach(s => retFromMap[s.id] = `${s.first_name} ${s.last_name}`);
    }

    (retractedEva || []).forEach(n => {
      if (alerts.some(a => a.notif_id === n.id)) return;
      const dateStr = n.created_at ? new Date(n.created_at).toLocaleDateString('es-CO',{day:'numeric',month:'short'}) : '';
      const sender  = retFromMap[n.from_user_id] ? ` · Docente: ${retFromMap[n.from_user_id]}` : '';
      alerts.push({
        id: n.id, source: 'notification', type: 'evasion_retracted',
        severity: 'low', ico: '✅',
        title: (n.title || 'Posible evasión').replace(/^🚨\s*|^🏃\s*/,''),
        description: `${n.body || ''}${sender}${dateStr ? ' · '+dateStr : ''}`,
        notif_id: n.id, link_id: n.link_id,
      });
    });
  } catch (_) {}

  // ── 3. Todos los casos RAICE abiertos ──
  try {
    let casesQ = sb.from('raice_cases')
      .select('id, student_name, type, created_at, grade, course')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10);
    if (sedeCourseIds) casesQ = casesQ.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
    const { data: openCases } = await casesQ;

    (openCases || []).forEach(c => {
      const daysOpen = Math.floor((Date.now() - new Date(c.created_at)) / 86400000);
      const severity = c.type >= 2 ? 'high' : daysOpen >= 3 ? 'medium' : 'low';
      const ageLabel = daysOpen === 0 ? 'Abierto hoy' : daysOpen === 1 ? 'Abierto ayer' : `Abierto hace ${daysOpen} días`;
      alerts.push({
        source: 'computed', type: 'case',
        severity, ico: c.type >= 3 ? '🚨' : c.type >= 2 ? '⚠️' : '📋',
        title: `Caso Tipo ${c.type} — ${c.student_name}`,
        description: `${c.grade ? c.grade+'°'+(c.course||'') : ''} · ${ageLabel}`,
      });
    });
  } catch (_) {}

  // ── 4. Estudiantes con 2+ ausencias en los últimos 7 días ──
  // Si hay filtro de sede usamos la query manual (filtra por course_id exacto).
  // El RPC no acepta course_ids y filtrar por grado/número es ambiguo entre sedes.
  if (sedeCourseIds) {
    // Coordinador con sede: query directa filtrada por course_id
    try {
      let abQ = sb.from('raice_attendance')
        .select('student_id, course_id, raice_students(first_name, last_name, grade, course)')
        .eq('status', 'A')
        .gte('date', sevenAgo)
        .in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000'])
        .limit(300);
      const { data: abRows } = await abQ;
      const countMap = {};
      (abRows || []).forEach(a => {
        if (!countMap[a.student_id]) countMap[a.student_id] = { count: 0, stu: a.raice_students };
        countMap[a.student_id].count++;
      });
      Object.values(countMap).filter(v => v.count >= 2 && v.stu).forEach(v => {
        alerts.push({
          source: 'computed', type: 'absence',
          severity: v.count >= 4 ? 'high' : 'medium', ico: '📋',
          title: `${v.stu.first_name} ${v.stu.last_name} — ${v.count} ausencias en 7 días`,
          description: `${v.stu.grade}°${v.stu.course || ''}`
        });
      });
    } catch (_) {}
  } else {
    // Superadmin / rector: intentar RPC primero, fallback manual
    try {
      const r = await sb.rpc('get_repeated_absences', { since_date: sevenAgo });
      (r.data || []).forEach(a => alerts.push({
        source: 'computed', type: 'absence', severity: a.count >= 4 ? 'high' : 'medium', ico: '📋',
        title: `${a.student_name} — ${a.count} ausencias en 7 días`,
        description: `${a.grade}°${a.course} · Última falta: ${a.last_date}`
      }));
    } catch (_) {
      try {
        const { data: abRows } = await sb.from('raice_attendance')
          .select('student_id, raice_students(first_name, last_name, grade, course)')
          .eq('status', 'A').gte('date', sevenAgo).limit(300);
        const countMap = {};
        (abRows || []).forEach(a => {
          if (!countMap[a.student_id]) countMap[a.student_id] = { count: 0, stu: a.raice_students };
          countMap[a.student_id].count++;
        });
        Object.values(countMap).filter(v => v.count >= 2 && v.stu).forEach(v => {
          alerts.push({
            source: 'computed', type: 'absence',
            severity: v.count >= 4 ? 'high' : 'medium', ico: '📋',
            title: `${v.stu.first_name} ${v.stu.last_name} — ${v.count} ausencias en 7 días`,
            description: `${v.stu.grade}°${v.stu.course || ''}`
          });
        });
      } catch (_) {}
    }
  }

  // ── 5. Compromisos por vencer ──
  try {
    const { count } = await sb.from('raice_commitments')
      .select('id', { count: 'exact', head: true })
      .eq('fulfilled', false).lt('due_date', todayCO(3));
    if (count > 0) alerts.push({
      source: 'computed', type: 'commitment', severity: 'medium', ico: '🗓️',
      title: `${count} compromiso${count>1?'s':''} por vencer pronto`,
      description: 'Revisa la sección de compromisos'
    });
  } catch (_) {}

  // ── 6. Omisiones de asistencia (docentes que no han llamado lista HOY) ──
  try {
    const { data: calDay } = await sb.from('raice_calendar').select('type').eq('date', today);
    const isHoliday = calDay && calDay.some(c => c.type === 'holiday' || c.type === 'vacation' || c.type === 'institutional_day');

    if (!isHoliday) {
      const coDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const dayOfWeek = coDate.getDay() || 7;
      const currentTimeStr = `${coDate.getHours().toString().padStart(2, '0')}:${coDate.getMinutes().toString().padStart(2, '0')}:00`;

      const { data: scheds } = await sb.from('raice_schedules')
        .select(`
          class_hour,
          start_time,
          raice_teacher_courses (
            teacher_id,
            course_id,
            subject,
            raice_users ( first_name, last_name ),
            raice_courses ( grade, number, type, name )
          )
        `)
        .eq('day_of_week', dayOfWeek);

      const { data: bells } = await sb.from('raice_bell_schedule').select('class_hour, start_time');
      const bellMap = {};
      (bells || []).forEach(b => bellMap[b.class_hour] = b.start_time);

      if (scheds && scheds.length > 0) {
        // Get today's attendance records — exclude PE (excusas) and NR
        const { data: todayAtt } = await sb.from('raice_attendance')
          .select('course_id, class_hour, status').eq('date', today);
        const takenSet = new Set((todayAtt || [])
          .filter(a => a.status !== 'PE' && a.status !== 'NR')
          .map(a => `${a.course_id}_${a.class_hour}`));

        let pastScheds = scheds.filter(s => {
          const st = s.start_time || bellMap[s.class_hour];
          return st && st < currentTimeStr;
        });
        // Filtrar por sede si aplica
        if (sedeCourseIds) {
          const sedeSet = new Set(sedeCourseIds);
          pastScheds = pastScheds.filter(s => s.raice_teacher_courses?.course_id && sedeSet.has(s.raice_teacher_courses.course_id));
        }

        pastScheds.forEach(s => {
          const tc = s.raice_teacher_courses;
          if (!tc || !tc.course_id || !tc.raice_users || !tc.raice_courses) return;
          if (!takenSet.has(`${tc.course_id}_${s.class_hour}`)) {
            const teacherName = `${tc.raice_users.first_name} ${tc.raice_users.last_name}`;
            const rc2 = tc.raice_courses;
            const courseName = rc2.type === 'subgroup' ? (rc2.name || 'Subgrupo') : `${rc2.grade}°${rc2.number}`;
            const subject = tc.subject || '—';
            alerts.push({
              source: 'computed', type: 'attendance_omission', severity: 'high', ico: '🚨',
              title: `${teacherName} — sin llamar lista`,
              description: `${courseName} · ${subject} · Hora ${s.class_hour} · ${today}`,
              _teacher: teacherName,
              _course: courseName,
              _subject: subject,
              _hour: s.class_hour,
              _date: today,
              _course_id: tc.course_id,
              _teacher_id: tc.teacher_id,
            });
          }
        });
      }
    }
  } catch (err) {
    console.error('Alerts: omissions error', err);
  }

  // Sort: high → medium → low, notifications before computed
  const sevOrd = { high: 0, medium: 1, low: 2 };
  const srcOrd = { notification: 0, computed: 1 };
  alerts.sort((a, b) =>
    (srcOrd[a.source]||1) - (srcOrd[b.source]||1) ||
    (sevOrd[a.severity]||1) - (sevOrd[b.severity]||1)
  );

  return res.status(200).json({ alerts, total: alerts.length });
}

async function handleUsers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // ?directory=true — todos los coordinadores pueden ver todo el personal (para planillas de asistencia)
    const isDirectory = url.searchParams.get('directory') === 'true';

    let q = sb.from('raice_users')
      .select('id, username, first_name, last_name, email, role, active, last_login, subject, sede_id')
      .order('first_name');
    if (user.role !== 'superadmin') q = q.neq('role', 'superadmin');
    // En modo directorio el admin ve todo el personal (para planillas de asistencia a reuniones)
    if (!isDirectory) {
      if (user.role === 'admin') {
        // Leer sedes desde BD siempre (JWT puede estar desactualizado — bug #4)
        const sedeFilter = url.searchParams.get('sede_filter');
        const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilter);
        if (adminSedeIds && adminSedeIds.length > 0) {
          q = q.in('sede_id', adminSedeIds);
        } else {
          q = q.in('sede_id', ['00000000-0000-0000-0000-000000000000']);
        }
      } else {
        q = sedeScope(q, user);
      }
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Error al cargar usuarios' });

    // Fetch all sedes to map names in memory (removes reliance on DB-level join which can fail if FK constraint is missing)
    let sedesMap = {};
    try {
      const { data: sList } = await sb.from('raice_sedes').select('id, name');
      (sList || []).forEach(s => {
        sedesMap[s.id] = s.name;
      });
    } catch (_) {}

    // Batch: get course counts for all users in one query instead of N+1
    const userIds = (data || []).map(u => u.id);
    const courseCountMap = {};
    if (userIds.length) {
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('teacher_id').in('teacher_id', userIds);
      (tcRows || []).forEach(r => {
        courseCountMap[r.teacher_id] = (courseCountMap[r.teacher_id] || 0) + 1;
      });
    }

    // Cargar asignaciones de sedes para coordinadores (admin)
    // Protegido con try-catch por si raice_user_sedes aún no se ha migrado
    const adminIds = (data || []).filter(u => u.role === 'admin').map(u => u.id);
    const userSedesMap = {};
    if (adminIds.length) {
      try {
        const { data: usRows } = await sb.from('raice_user_sedes')
          .select('user_id, sede_id')
          .in('user_id', adminIds);
        (usRows || []).forEach(s => {
          if (!userSedesMap[s.user_id]) userSedesMap[s.user_id] = [];
          userSedesMap[s.user_id].push({ id: s.sede_id, name: sedesMap[s.sede_id] });
        });
      } catch (_) { /* tabla aún no migrada */ }
    }

    const withCounts = (data || []).map(u => {
      const sedeEntries = u.role === 'admin' ? (userSedesMap[u.id] || []) : [];
      return {
        ...u,
        sede_name:  u.role === 'admin'
          ? (sedeEntries.length === 1 ? sedeEntries[0].name : (sedeEntries.length > 1 ? `${sedeEntries.length} sedes` : null))
          : (sedesMap[u.sede_id] || null),
        sede_ids:   u.role === 'admin' ? sedeEntries.map(s => s.id)   : null,
        sede_names: u.role === 'admin' ? sedeEntries.map(s => s.name) : null,
        courses_count: courseCountMap[u.id] || 0,
      };
    });
    return res.status(200).json({ users: withCounts });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { first_name, last_name, username, email, role, password, sede_id: newUserSede, sede_ids: newUserSedeIds } = req.body || {};
    if (!first_name || !username || !password) return res.status(400).json({ error: 'Faltan campos requeridos' });

    // Only superadmin can create admin/superadmin/rector accounts
    const assignedRole = role || 'teacher';
    if (['admin', 'superadmin', 'rector'].includes(assignedRole) && user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo el superadministrador puede crear coordinadores o rectores' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    if (assignedRole === 'admin') {
      // Coordinador: sede_id queda null en raice_users; sedes van en raice_user_sedes
      const { data: newUser, error } = await sb.from('raice_users').insert({
        first_name, last_name, username: username.toLowerCase(), email, role: assignedRole,
        password_hash, active: true, sede_id: null
      }).select().single();
      if (error) return res.status(500).json({ error: error.code === '23505' ? 'El nombre de usuario ya existe' : 'Error al crear usuario' });
      // Insertar asignaciones de sedes
      const sedeArr = Array.isArray(newUserSedeIds) ? newUserSedeIds.filter(Boolean) : [];
      if (sedeArr.length) {
        try { await sb.from('raice_user_sedes').insert(sedeArr.map(sid => ({ user_id: newUser.id, sede_id: sid }))); } catch (_) {}
      }
      await logActivity(sb, user.id, 'create_user', `Usuario creado: @${username}`);
      return res.status(200).json({ success: true, user: newUser });
    }

    // Rector / superadmin / teacher: sede_id simple (rector siempre null)
    let effectiveSede;
    if (assignedRole === 'rector' || assignedRole === 'superadmin') {
      effectiveSede = null;
    } else if (user.role === 'superadmin') {
      effectiveSede = newUserSede || null;
    } else {
      // Admin coordinador creando un docente: valida la sede desde la BD (no JWT)
      const adminSedes = await getAdminSedeIds(sb, user) || [];
      if (newUserSede && (adminSedes.length === 0 || adminSedes.includes(newUserSede))) {
        effectiveSede = newUserSede;
      } else {
        effectiveSede = adminSedes[0] || null;
      }
    }
    const { data, error } = await sb.from('raice_users').insert({
      first_name, last_name, username: username.toLowerCase(), email, role: assignedRole,
      password_hash, active: true, sede_id: effectiveSede
    }).select().single();

    if (error) return res.status(500).json({ error: error.code === '23505' ? 'El nombre de usuario ya existe' : 'Error al crear usuario' });
    await logActivity(sb, user.id, 'create_user', `Usuario creado: @${username}`);
    return res.status(200).json({ success: true, user: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, first_name, last_name, username, email, role, subject, active, password, sede_id: newSedeId, sede_ids: newSedeIds } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    if (role && ['admin','superadmin','rector'].includes(role) && user.role !== 'superadmin')
      return res.status(403).json({ error: 'Solo el superadministrador puede asignar ese rol' });

    const updates = { first_name, last_name, subject, active };
    if (username) updates.username = username.toLowerCase();
    if (email !== undefined) updates.email = email;
    if (role && user.role === 'superadmin') updates.role = role;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    // Determinar el rol efectivo (puede estar cambiando)
    const effectiveRole = (role && user.role === 'superadmin') ? role : null;

    if (user.role === 'superadmin') {
      const targetRole = effectiveRole || role;
      if (targetRole === 'admin') {
        // Coordinador: mantener sede_id null en raice_users; actualizar raice_user_sedes
        updates.sede_id = null;
      } else if (targetRole === 'rector' || targetRole === 'superadmin') {
        // Rector/superadmin: sin sede nunca
        updates.sede_id = null;
      } else if (newSedeId !== undefined) {
        // Teacher u otros: sede_id simple
        updates.sede_id = newSedeId || null;
      }
    }

    const { error } = await sb.from('raice_users').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'El nombre de usuario ya existe' : 'Error al actualizar' });

    // Actualizar asignaciones de sedes para coordinadores (solo superadmin puede)
    if (user.role === 'superadmin' && newSedeIds !== undefined) {
      try {
        const targetRole = effectiveRole || role;
        if (!targetRole || targetRole === 'admin') {
          await sb.from('raice_user_sedes').delete().eq('user_id', id);
          const sedeArr = Array.isArray(newSedeIds) ? newSedeIds.filter(Boolean) : [];
          if (sedeArr.length) {
            await sb.from('raice_user_sedes').insert(sedeArr.map(sid => ({ user_id: id, sede_id: sid })));
          }
        } else {
          await sb.from('raice_user_sedes').delete().eq('user_id', id);
        }
      } catch (_) { /* tabla aún no migrada */ }
    }

    await logActivity(sb, user.id, 'update_user', `Usuario ${id} actualizado`);
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id, force } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // Cannot delete yourself
    if (id === user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    // Check if user has associated data (attendance records, cases, etc.)
    const [attCount, casesCount, obsCount] = await Promise.all([
      sb.from('raice_attendance').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
      sb.from('raice_cases').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
      sb.from('raice_observations').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
    ]);
    const totalRefs = (attCount.count || 0) + (casesCount.count || 0) + (obsCount.count || 0);
    if (totalRefs > 0 && !force) {
      return res.status(409).json({
        error: 'El usuario tiene registros asociados',
        refs: { attendance: attCount.count || 0, cases: casesCount.count || 0, observations: obsCount.count || 0 },
        canForce: true
      });
    }
    // Remove teacher-course and sede assignments first
    await Promise.all([
      sb.from('raice_teacher_courses').delete().eq('teacher_id', id),
      sb.from('raice_user_sedes').delete().eq('user_id', id).then(() => {}).catch(() => {}),
    ]);
    const { error } = await sb.from('raice_users').delete().eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'delete_user', `Usuario ${id} eliminado`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

async function resetUserPassword(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { id, password } = req.body || {};
  if (!id || !password) return res.status(400).json({ error: 'ID y contraseña requeridos' });
  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await sb.from('raice_users').update({ password_hash }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Error al actualizar contraseña' });
  await logActivity(sb, user.id, 'reset_password', `Contraseña reseteada para usuario ${id}`);
  return res.status(200).json({ success: true });
}

// =====================================================
// STUDENTS
// =====================================================

async function handleStudents(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    let query = sb.from('raice_students')
      .select('id, first_name, last_name, grade, course, course_id, doc_type, doc_number, birth_date, phone, status, notes')
      .order('grade').order('course').order('last_name');

    const isAdmin = ['superadmin','admin','rector'].includes(user.role);
    const courseId = url.searchParams.get('course_id');
    // Teachers always see only active students; admins see all by default
    if (!isAdmin) query = query.eq('status', 'active');

    if (courseId) {
      // Teachers can only access their own courses — validate access
      if (!isAdmin) {
        const { data: tcCheck } = await sb.from('raice_teacher_courses')
          .select('id').eq('teacher_id', user.id).eq('course_id', courseId).limit(1);
        if (!tcCheck || !tcCheck.length) return res.status(403).json({ error: 'No tienes acceso a este curso' });
      }
      query = query.eq('course_id', courseId);
    } else if (!isAdmin) {
      // Teacher: only their assigned courses
      const { data: teacherCourses } = await sb.from('raice_teacher_courses')
        .select('course_id').eq('teacher_id', user.id);
      const ids = (teacherCourses || []).map(tc => tc.course_id);
      if (ids.length) query = query.in('course_id', ids);
      else return res.status(200).json({ students: [] });
    } else if (user.role === 'admin') {
      // Siempre leemos desde la BD — soporte de sede_filter (sede activa del coordinador)
      const stuSedeFilter = url.searchParams.get('sede_filter');
      const adminSedeIds = await getAdminSedeIds(sb, user, stuSedeFilter);
      if (adminSedeIds && adminSedeIds.length > 0) {
        const { data: sedeCourses } = await sb.from('raice_courses')
          .select('id').in('sede_id', adminSedeIds).neq('type', 'subgroup');
        const ids = (sedeCourses || []).map(c => c.id);
        if (ids.length) query = query.in('course_id', ids);
        else return res.status(200).json({ students: [] });
      } else {
        return res.status(200).json({ students: [] });
      }
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Error al cargar estudiantes' });
    const students = data || [];

    if (!students.length) return res.status(200).json({ students: [] });

    // Enrich with cases_count, attendance % and sede info in memory without DB joins
    const studentIds = students.map(s => s.id);
    const monthStart = todayCO().substring(0, 8) + '01'; // YYYY-MM-01 in Colombia time

    // Fetch cases and attendance without .in() to avoid PostgREST URL length limit with many UUIDs
    const studentIdSet = new Set(studentIds);
    const [casesRes, attRes, coursesRes, sedesRes] = await Promise.all([
      sb.from('raice_cases').select('student_id'),
      sb.from('raice_attendance')
        .select('student_id, status')
        .gte('date', monthStart),
      sb.from('raice_courses').select('id, name, type, sede_id'),
      sb.from('raice_sedes').select('id, name')
    ]);

    // Build cases map (filter in memory by active students)
    const casesMap = {};
    (casesRes.data || []).forEach(c => {
      if (!studentIdSet.has(c.student_id)) return;
      casesMap[c.student_id] = (casesMap[c.student_id] || 0) + 1;
    });

    // Build attendance map (filter in memory by active students)
    const attMap = {};
    (attRes.data || []).forEach(a => {
      if (!studentIdSet.has(a.student_id)) return;
      if (!attMap[a.student_id]) attMap[a.student_id] = { total: 0, present: 0 };
      attMap[a.student_id].total++;
      if (a.status === 'P' || a.status === 'PE') attMap[a.student_id].present++;
    });

    // Build courses and sedes maps
    const coursesMap = {};
    (coursesRes.data || []).forEach(c => {
      coursesMap[c.id] = c;
    });
    const sedesMap = {};
    (sedesRes.data || []).forEach(s => {
      sedesMap[s.id] = s.name;
    });

    const enriched = students.map(s => {
      const courseObj = coursesMap[s.course_id] || {};
      const sedeName = sedesMap[courseObj.sede_id] || null;
      return {
        ...s,
        sede_id: courseObj.sede_id || null,
        sede_name: sedeName,
        cases_count: casesMap[s.id] || 0,
        att_pct: attMap[s.id] && attMap[s.id].total > 0
          ? Math.round((attMap[s.id].present / attMap[s.id].total) * 100)
          : null
      };
    });

    return res.status(200).json({ students: enriched });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { first_name, last_name, course_id, doc_type, doc_number, birth_date, phone, status, notes } = req.body || {};
    if (!first_name || !last_name) return res.status(400).json({ error: 'Nombre y apellido son obligatorios' });
    if (!course_id) return res.status(400).json({ error: 'Debes seleccionar el curso' });

    // Get grade/course number from course
    const { data: courseData } = await sb.from('raice_courses').select('grade, number').eq('id', course_id).single();
    if (!courseData) return res.status(400).json({ error: 'Curso no encontrado' });

    const { data, error } = await sb.from('raice_students').insert({
      first_name: first_name.trim(),
      last_name: last_name.trim(),
      course_id,
      grade: courseData.grade,
      course: courseData.number,
      doc_type: doc_type || 'TI',
      doc_number: doc_number || null,
      birth_date: birth_date || null,
      phone: phone || null,
      status: status || 'active',
      notes: notes || null
    }).select().single();

    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'create_student', `Estudiante creado: ${first_name} ${last_name}`);
    return res.status(200).json({ success: true, student: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, first_name, last_name, course_id, doc_type, doc_number, birth_date, phone, status, notes, grade_change_reason, grade_change_notes } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    let updates = { first_name, last_name, doc_type, doc_number, birth_date, phone: phone || null, status, notes };

    // Detectar cambio de grado/curso y registrar historial
    if (course_id) {
      // Leer estado actual del estudiante antes de modificar
      const { data: currentStudent } = await sb.from('raice_students')
        .select('grade, course, course_id').eq('id', id).single();

      const { data: courseData } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();

      if (courseData) {
        updates.course_id = course_id;
        updates.grade     = courseData.grade;
        updates.course    = courseData.number;

        // Solo registrar historial si el curso realmente cambió
        const courseChanged = currentStudent && String(currentStudent.course_id) !== String(course_id);
        if (courseChanged) {
          await sb.from('raice_student_grade_history').insert({
            student_id:    id,
            from_grade:    currentStudent.grade,
            from_course:   currentStudent.course,
            from_course_id: currentStudent.course_id,
            to_grade:      courseData.grade,
            to_course:     courseData.number,
            to_course_id:  course_id,
            reason:        grade_change_reason || 'correction',
            notes:         grade_change_notes  || null,
            changed_by:    user.id,
            changed_at:    new Date().toISOString(),
          });
          await logActivity(sb, user.id, 'change_grade',
            `Estudiante ${id} movido de ${currentStudent.grade}°${currentStudent.course} a ${courseData.grade}°${courseData.number} (${grade_change_reason || 'correction'})`);
        }
      }
    }

    // Verificar si el estudiante está en un subgrupo cuando cambia de curso
    let subgroupWarning = null;
    if (updates.course_id) {
      const { data: memberRow } = await sb.from('raice_subgroup_members')
        .select('subgroup_course_id, raice_courses(name)')
        .eq('student_id', id)
        .maybeSingle();
      if (memberRow) {
        subgroupWarning = memberRow.raice_courses?.name || 'Subgrupo';
      }
    }

    const { error } = await sb.from('raice_students').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al actualizar estudiante' });
    if (!updates.course_id) {
      await logActivity(sb, user.id, 'update_student', `Estudiante ${id} actualizado`);
    }
    return res.status(200).json({ success: true, subgroup_warning: subgroupWarning });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin', 'admin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    // Fetch student name before deletion for the log
    const { data: stData } = await sb.from('raice_students')
      .select('first_name, last_name').eq('id', id).maybeSingle();
    const studentLabel = stData ? `${stData.first_name} ${stData.last_name}` : `ID ${id}`;

    // Get all case IDs for this student (needed to delete case-child tables)
    const { data: studentCases } = await sb.from('raice_cases')
      .select('id').eq('student_id', id);
    const caseIds = (studentCases || []).map(c => c.id);

    // Delete case-child records first (FK depends on raice_cases)
    if (caseIds.length) {
      await sb.from('raice_tipo1_escalones').delete().in('case_id', caseIds);
      await sb.from('raice_followups').delete().in('case_id', caseIds);
      await sb.from('raice_citations').delete().in('case_id', caseIds);
      await sb.from('raice_commitments').delete().in('case_id', caseIds);
    }

    // Delete student-level dependent records (FK depends on raice_students)
    await sb.from('raice_cases').delete().eq('student_id', id);
    await sb.from('raice_attendance').delete().eq('student_id', id);
    await sb.from('raice_observations').delete().eq('student_id', id);
    await sb.from('raice_acudientes').delete().eq('student_id', id);
    await sb.from('raice_suspensions').delete().eq('student_id', id);
    await sb.from('raice_classroom_removals').delete().eq('student_id', id);
    await sb.from('raice_excusas').delete().eq('student_id', id);
    await sb.from('raice_student_grade_history').delete().eq('student_id', id);
    await sb.from('raice_notifications').delete().eq('link_id', id);

    // Now delete the student record itself
    const { error } = await sb.from('raice_students').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar estudiante' });
    await logActivity(sb, user.id, 'delete_student', `Estudiante eliminado: ${studentLabel}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

async function importStudents(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();

  const sb = getSupabase();
  const { students, sede_id: bodySedeId } = req.body || {};
  if (!Array.isArray(students) || !students.length) return res.status(400).json({ error: 'No hay estudiantes para importar' });

  // Determinar sede de destino para los estudiantes importados
  let targetSedeId = null;
  if (user.role === 'superadmin') {
    // Superadmin envía sede_id explícitamente desde el selector del panel
    targetSedeId = bodySedeId || null;
  } else {
    // Admin: usar sede_id enviado (activeSede del topbar), validando que le pertenezca
    const adminSedes = await getAdminSedeIds(sb, user);
    if (bodySedeId && adminSedes && adminSedes.includes(bodySedeId)) {
      targetSedeId = bodySedeId;
    } else {
      targetSedeId = (adminSedes && adminSedes[0]) || null;
    }
  }

  let imported = 0, updated = 0, skipped = 0, errors = [];

  // ── 1. Cargar cursos y estudiantes existentes en paralelo (2 queries) ──
  const [coursesRes, existingRes] = await Promise.all([
    sb.from('raice_courses').select('id, grade, number'),
    sb.from('raice_students').select('id, first_name, last_name, grade, course')
  ]);

  // Mapa de cursos: "grade_course" -> course_id
  const courseMap = new Map((coursesRes.data || []).map(c => [`${c.grade}_${c.number}`, c.id]));

  // Mapa de estudiantes existentes: "nombre_apellido_grado_curso" -> {id}
  const existingMap = new Map();
  for (const e of (existingRes.data || [])) {
    const key = `${e.first_name.trim().toLowerCase()}_${e.last_name.trim().toLowerCase()}_${e.grade}_${e.course}`;
    existingMap.set(key, e);
  }

  // ── 2. Filtrar filas inválidas ──
  const valid = students.filter(s => s.first_name && s.last_name && s.grade);
  skipped += students.length - valid.length;

  // ── 3. Crear cursos faltantes si los hay (1 query extra, solo si faltan) ──
  const missingCourseKeys = new Set();
  for (const s of valid) {
    const key = `${parseInt(s.grade)}_${parseInt(s.course) || 1}`;
    if (!courseMap.has(key)) missingCourseKeys.add(key);
  }
  if (missingCourseKeys.size) {
    const toCreate = [...missingCourseKeys].map(k => {
      const [grade, number] = k.split('_').map(Number);
      return { grade, number, sede_id: targetSedeId };
    });
    const { data: newCourses } = await sb.from('raice_courses').insert(toCreate).select('id, grade, number');
    for (const c of (newCourses || [])) courseMap.set(`${c.grade}_${c.number}`, c.id);
  }

  // ── 4. Separar en nuevos y a actualizar (en memoria, sin queries) ──
  const toInsert = [];
  const toUpdate = []; // { id, patch, label }

  // Contador por grado/curso basado en estudiantes ya existentes
  const courseCounters = new Map();
  for (const e of (existingRes.data || [])) {
    const k = `${e.grade}_${e.course}`;
    courseCounters.set(k, (courseCounters.get(k) || 0) + 1);
  }

  for (const s of valid) {
    const grade  = parseInt(s.grade);
    const course = parseInt(s.course) || 1;
    const key    = `${s.first_name.trim().toLowerCase()}_${s.last_name.trim().toLowerCase()}_${grade}_${course}`;
    const found  = existingMap.get(key);

    if (found) {
      const patch = {};
      if ('doc_type'   in s && s.doc_type)   patch.doc_type   = s.doc_type;
      if ('doc_number' in s) patch.doc_number = s.doc_number ?? null;
      if ('birth_date' in s) patch.birth_date = s.birth_date ?? null;
      if ('phone'      in s) patch.phone      = s.phone      ?? null;
      if (Object.keys(patch).length) toUpdate.push({ id: found.id, patch, label: `${s.first_name} ${s.last_name}` });
      else skipped++;
    } else {
      const ck  = `${grade}_${course}`;
      const seq = (courseCounters.get(ck) || 0) + 1;
      courseCounters.set(ck, seq);
      toInsert.push({
        first_name: s.first_name.trim(),
        last_name:  s.last_name.trim(),
        grade, course,
        course_id:  courseMap.get(`${grade}_${course}`) || null,
        doc_type:   s.doc_type   || 'TI',
        doc_number: s.doc_number || null,
        birth_date: s.birth_date || null,
        phone:      s.phone      || null,
        sede_id:    targetSedeId,
        code: `${String(grade).padStart(2,'0')}${String(course).padStart(2,'0')}${String(seq).padStart(3,'0')}`,
        status: 'active'
      });
    }
  }

  // ── 5. Inserción masiva en lotes de 100 ──
  for (let i = 0; i < toInsert.length; i += 100) {
    const batch = toInsert.slice(i, i + 100);
    const { error } = await sb.from('raice_students').insert(batch);
    if (error) errors.push(`Inserción lote ${Math.floor(i / 100) + 1}: ${error.message}`);
    else imported += batch.length;
  }

  // ── 6. Actualizaciones en paralelo (20 simultáneas) ──
  const CONCURRENCY = 20;
  for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
    const batch = toUpdate.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ id, patch, label }) =>
        sb.from('raice_students').update(patch).eq('id', id)
          .then(({ error }) => ({ error, label }))
      )
    );
    for (const { error, label } of results) {
      if (error) errors.push(`${label}: ${error.message}`);
      else updated++;
    }
  }

  await logActivity(sb, user.id, 'import_students', `${imported} creados, ${updated} actualizados`);
  return res.status(200).json({ success: true, imported, updated, skipped, errors: errors.slice(0, 20) });
}

// =====================================================
// TEACHERS
// =====================================================

// =====================================================
// SIMAT IMPORT
// =====================================================

function normName(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function _createSimatStudent(sb, s) {
  let courseId = s.course_id || null;
  if (!courseId) {
    const { data: c } = await sb.from('raice_courses')
      .select('id').eq('grade', s.grade).eq('number', s.course).single();
    courseId = c?.id || null;
  }
  const code = `S${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  const { error } = await sb.from('raice_students').insert({
    first_name: s.first_name, last_name: s.last_name,
    grade: s.grade, course: s.course, course_id: courseId,
    doc_type: s.doc_type || 'TI', doc_number: s.doc_number || null,
    birth_date: s.birth_date || null, phone: s.phone || null,
    code, status: 'active',
  });
  return error ? { error: `${s.first_name} ${s.last_name}: ${error.message}` } : { ok: true };
}

async function simatPreview(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { students: simat, mode } = req.body || {};
  if (!Array.isArray(simat) || !simat.length)
    return res.status(400).json({ error: 'No hay estudiantes para analizar' });

  const { data: existingCourses } = await sb.from('raice_courses').select('id, grade, number');
  const courseSet = new Set((existingCourses || []).map(c => `${c.grade}_${c.number}`));
  const courseIdMap = {};
  (existingCourses || []).forEach(c => { courseIdMap[`${c.grade}_${c.number}`] = c.id; });

  if (mode === 'initial') {
    const { data: existing } = await sb.from('raice_students')
      .select('first_name, last_name, grade, course').eq('status', 'active');
    const dupSet = new Set((existing || []).map(s =>
      `${normName(s.first_name + ' ' + s.last_name)}_${s.grade}_${s.course}`));

    const toCreate = [], newCoursesMap = {}, duplicates = [];
    for (const s of simat) {
      const ck = `${s.grade}_${s.course}`;
      const dk = `${normName(s.first_name + ' ' + s.last_name)}_${s.grade}_${s.course}`;
      if (dupSet.has(dk)) { duplicates.push(s); continue; }
      if (!courseSet.has(ck)) {
        if (!newCoursesMap[ck]) newCoursesMap[ck] = { grade: s.grade, course: s.course, students: [] };
        newCoursesMap[ck].students.push(s);
      } else {
        toCreate.push(s);
      }
    }
    return res.status(200).json({
      mode: 'initial',
      to_create: toCreate,
      new_courses: Object.values(newCoursesMap),
      duplicates,
    });
  }

  if (mode === 'update') {
    const { data: raiceAll } = await sb.from('raice_students')
      .select('id, first_name, last_name, grade, course').eq('status', 'active');
    const raiceStudents = raiceAll || [];

    const exact = [], partial = [], noMatchExisting = [], newCoursesMap = {};

    for (const s of simat) {
      const sNorm = normName(s.first_name + ' ' + s.last_name);
      const ck = `${s.grade}_${s.course}`;

      // Exact match by full normalized name
      const exactMatch = raiceStudents.filter(r => normName(r.first_name + ' ' + r.last_name) === sNorm);
      if (exactMatch.length === 1) { exact.push({ simat: s, raice: exactMatch[0] }); continue; }

      // Partial match by token overlap
      const sTokens = sNorm.split(' ').filter(Boolean);
      const candidates = raiceStudents
        .map(r => {
          const rTokens = normName(r.first_name + ' ' + r.last_name).split(' ').filter(Boolean);
          const matched = sTokens.filter(t => rTokens.includes(t)).length;
          const score = matched / Math.max(sTokens.length, rTokens.length);
          return { ...r, score, matched };
        })
        .filter(r => r.score >= 0.5 && r.matched >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ score, matched, ...r }) => r);

      if (candidates.length > 0) { partial.push({ simat: s, candidates }); continue; }

      // No match
      if (!courseSet.has(ck)) {
        if (!newCoursesMap[ck]) newCoursesMap[ck] = { grade: s.grade, course: s.course, students: [] };
        newCoursesMap[ck].students.push(s);
      } else {
        noMatchExisting.push(s);
      }
    }
    return res.status(200).json({
      mode: 'update',
      exact,
      partial,
      no_match_existing: noMatchExisting,
      new_courses: Object.values(newCoursesMap),
    });
  }

  return res.status(400).json({ error: 'Modo inválido' });
}

async function simatImport(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { updates = [], creates = [], create_courses = [] } = req.body || {};

  let updatedCount = 0, createdStudents = 0, createdCourses = 0;
  const errors = [];

  // 1. Update existing students
  for (const u of updates) {
    const patch = {};
    if (u.doc_type)   patch.doc_type   = u.doc_type;
    if (u.doc_number) patch.doc_number = u.doc_number;
    if (u.birth_date) patch.birth_date = u.birth_date;
    if (u.phone)      patch.phone      = u.phone;
    if (!Object.keys(patch).length) continue;
    const { error } = await sb.from('raice_students').update(patch).eq('id', u.student_id);
    if (error) errors.push(`Update ${u.student_id}: ${error.message}`);
    else updatedCount++;
  }

  // 2. Create students in existing courses
  for (const s of creates) {
    const r = await _createSimatStudent(sb, s);
    if (r.error) errors.push(r.error); else createdStudents++;
  }

  // 3. Create new courses + their students
  for (const c of create_courses) {
    const { data: newCourse, error: ce } = await sb.from('raice_courses')
      .insert({ grade: c.grade, number: c.course }).select().single();
    if (ce) { errors.push(`Curso ${c.grade}°${c.course}: ${ce.message}`); continue; }
    createdCourses++;
    for (const s of (c.students || [])) {
      const r = await _createSimatStudent(sb, { ...s, course_id: newCourse.id });
      if (r.error) errors.push(r.error); else createdStudents++;
    }
  }

  await logActivity(sb, user.id, 'simat_import',
    `SIMAT: ${updatedCount} actualizados, ${createdStudents} creados, ${createdCourses} cursos nuevos`);
  return res.status(200).json({
    success: true, updated: updatedCount,
    created_students: createdStudents, created_courses: createdCourses,
    errors: errors.slice(0, 10),
  });
}

async function handleTeachers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sedeFilter = url.searchParams.get('sede_filter');

  let tq = sb.from('raice_users')
    .select('id, username, first_name, last_name, email, subject, active, last_login, sede_id')
    .eq('role', 'teacher').order('first_name');

  if (user.role === 'superadmin' && sedeFilter) {
    // Superadmin filtra por sede específica
    tq = tq.eq('sede_id', sedeFilter);
  } else if (user.role === 'admin') {
    // Coordinador: mostrar docentes que tienen cursos asignados en sus sedes
    // (robusto — no depende de raice_users.sede_id)
    const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilter);
    if (adminSedeIds && adminSedeIds.length > 0) {
      const { data: sedeCourses } = await sb.from('raice_courses')
        .select('id').in('sede_id', adminSedeIds);
      const sedeCourseIds = (sedeCourses || []).map(c => c.id);
      if (sedeCourseIds.length > 0) {
        const { data: tcRows } = await sb.from('raice_teacher_courses')
          .select('teacher_id').in('course_id', sedeCourseIds);
        const sedeTeacherIds = [...new Set((tcRows || []).map(r => r.teacher_id))];
        tq = sedeTeacherIds.length
          ? tq.in('id', sedeTeacherIds)
          : tq.in('id', ['00000000-0000-0000-0000-000000000000']);
      } else {
        tq = tq.in('id', ['00000000-0000-0000-0000-000000000000']);
      }
    } else {
      tq = tq.in('id', ['00000000-0000-0000-0000-000000000000']);
    }
  }

  const { data, error } = await tq;

  if (error) return res.status(500).json({ error: 'Error al cargar docentes' });

  const teacherIds = (data || []).map(t => t.id);
  const month_start = todayCO().substring(0, 8) + '01';

  // Batch: all teacher-course assignments and cases in 2 queries instead of 2N
  const [tcAll, casesAll] = await Promise.all([
    teacherIds.length
      ? sb.from('raice_teacher_courses')
          .select('teacher_id, raice_courses(grade,number,type,name)').in('teacher_id', teacherIds)
      : { data: [] },
    teacherIds.length
      ? sb.from('raice_cases')
          .select('teacher_id').in('teacher_id', teacherIds)
          .gte('created_at', month_start + 'T00:00:00')
      : { data: [] }
  ]);

  // Build lookup maps
  const tcMap = {};
  (tcAll.data || []).forEach(r => {
    if (!tcMap[r.teacher_id]) tcMap[r.teacher_id] = [];
    if (r.raice_courses) {
      const rc = r.raice_courses;
      tcMap[r.teacher_id].push(rc.type === 'subgroup' ? (rc.name || 'Subgrupo') : `${rc.grade}°${rc.number}`);
    }
  });
  const casesMap = {};
  (casesAll.data || []).forEach(r => {
    casesMap[r.teacher_id] = (casesMap[r.teacher_id] || 0) + 1;
  });

  const teachers = (data || []).map(t => ({
    ...t,
    courses: tcMap[t.id] || [],
    cases_this_month: casesMap[t.id] || 0
  }));

  return res.status(200).json({ teachers });
}

// =====================================================
// COURSES
// =====================================================

async function handleCourses(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    let coursesQ = sb.from('raice_courses')
      .select('id, grade, number, section, director_id, type, name, sede_id, raice_users(id, first_name, last_name)')
      .order('grade').order('number');
    // Usar BD directa para admin (evita JWT desactualizado)
    if (user.role === 'admin') {
      const adminSedeIds = await getAdminSedeIds(sb, user, null);
      if (adminSedeIds && adminSedeIds.length > 0) {
        coursesQ = coursesQ.in('sede_id', adminSedeIds);
      } else {
        coursesQ = coursesQ.in('sede_id', ['00000000-0000-0000-0000-000000000000']);
      }
    }
    const { data, error } = await coursesQ;
    if (error) return res.status(500).json({ error: 'Error al cargar cursos' });

    const courseIds   = (data || []).map(c => c.id);
    const normalIds   = (data || []).filter(c => c.type !== 'subgroup').map(c => c.id);
    const subgroupIds = (data || []).filter(c => c.type === 'subgroup').map(c => c.id);

    // Batch: students count (normal), subgroup members count, teacher assignments
    const [studentsAll, subgroupMembersAll, tcAll] = await Promise.all([
      normalIds.length
        ? sb.from('raice_students').select('course_id').eq('status', 'active').in('course_id', normalIds)
        : { data: [] },
      subgroupIds.length
        ? sb.from('raice_subgroup_members').select('subgroup_course_id').in('subgroup_course_id', subgroupIds)
        : { data: [] },
      courseIds.length
        ? sb.from('raice_teacher_courses')
            .select('id, course_id, teacher_id, subject, raice_users(first_name, last_name)')
            .in('course_id', courseIds)
        : { data: [] }
    ]);

    // Build lookup maps
    const studentCountMap = {};
    (studentsAll.data || []).forEach(s => {
      studentCountMap[s.course_id] = (studentCountMap[s.course_id] || 0) + 1;
    });
    (subgroupMembersAll.data || []).forEach(m => {
      studentCountMap[m.subgroup_course_id] = (studentCountMap[m.subgroup_course_id] || 0) + 1;
    });
    const tcByCourse = {};
    (tcAll.data || []).forEach(t => {
      if (!tcByCourse[t.course_id]) tcByCourse[t.course_id] = [];
      tcByCourse[t.course_id].push(t);
    });

    const courses = (data || []).map(c => {
      const tcRows = tcByCourse[c.id] || [];
      return {
        ...c,
        type: c.type || 'normal',
        name: c.name || null,
        director_id: c.director_id || null,
        students_count: studentCountMap[c.id] || 0,
        director: c.raice_users ? `${c.raice_users.first_name} ${c.raice_users.last_name}` : null,
        teachers: tcRows.map(t =>
          t.raice_users ? `${t.raice_users.first_name} ${t.raice_users.last_name}${t.subject ? ' ('+t.subject+')' : ''}` : null
        ).filter(Boolean),
        teachers_full: tcRows.map(t =>
          t.raice_users ? {
            assignment_id: t.id,
            teacher_id: t.teacher_id,
            name: `${t.raice_users.first_name} ${t.raice_users.last_name}`,
            subject: t.subject || ''
          } : null
        ).filter(Boolean)
      };
    });

    return res.status(200).json({ courses });
  }

  if (req.method === 'POST') {
    const { grade, number, director_id, type, name, sede_id: courseSede } = req.body || {};
    const courseType = type === 'subgroup' ? 'subgroup' : 'normal';
    const effectiveSede = user.role === 'superadmin'
      ? (courseSede || null)
      : (user.sede_id || (user.sede_ids && user.sede_ids[0]) || null);

    if (courseType === 'subgroup') {
      requireRole(user, 'superadmin');
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre del subgrupo es requerido' });
      const insertData = { type: 'subgroup', name: name.trim(), director_id: director_id || null, sede_id: effectiveSede };
      if (grade) insertData.grade = parseInt(grade);
      const { data, error } = await sb.from('raice_courses').insert(insertData).select().single();
      if (error) return res.status(500).json({ error: 'Error al crear subgrupo', detail: error.message, hint: error.hint });
      return res.status(200).json({ success: true, course: data });
    }

    if (!grade || !number) return res.status(400).json({ error: 'Grado y número de curso requeridos' });
    const { data, error } = await sb.from('raice_courses').insert({
      grade: parseInt(grade), number: parseInt(number),
      director_id: director_id || null, sede_id: effectiveSede
    }).select().single();
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'Este curso ya existe en esa sede' : 'Error al crear curso' });
    return res.status(200).json({ success: true, course: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, grade, number, director_id, name } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const { data: crsRow } = await sb.from('raice_courses').select('type').eq('id', id).maybeSingle();
    if (crsRow?.type === 'subgroup') {
      const { sede_id: subgroupSede } = req.body || {};
      const patch = { director_id: director_id || null };
      if (name?.trim()) patch.name = name.trim();
      if (subgroupSede) patch.sede_id = subgroupSede;
      if ('grade' in (req.body || {})) patch.grade = (grade != null && grade !== '') ? parseInt(grade) : null;
      const { data: updatedRow, error } = await sb.from('raice_courses').update(patch).eq('id', id).select('id, name, grade, sede_id').single();
      if (error) return res.status(500).json({ error: 'Error al actualizar subgrupo', detail: error.message });
      return res.status(200).json({ success: true, course: updatedRow, patch_sent: patch });
    } else {
      const { error } = await sb.from('raice_courses').update({
        grade: parseInt(grade), number: parseInt(number), director_id: director_id || null
      }).eq('id', id);
      if (error) return res.status(500).json({ error: 'Error al actualizar curso' });
    }
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const { error } = await sb.from('raice_courses').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar curso' });
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// SUBGROUP MEMBERS
// =====================================================

async function handleSubgroupMembers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const subgroup_id = url.searchParams.get('subgroup_id');
    const all_ids     = url.searchParams.get('all_ids');

    // Devuelve todos los student_id que ya están en ALGÚN subgrupo
    if (all_ids === 'true') {
      const { data, error } = await sb.from('raice_subgroup_members').select('student_id');
      if (error) return res.status(500).json({ error: 'Error al cargar ocupados' });
      return res.status(200).json({ occupied_ids: (data || []).map(r => r.student_id) });
    }

    if (!subgroup_id) return res.status(400).json({ error: 'subgroup_id requerido' });
    const { data: members, error } = await sb.from('raice_subgroup_members')
      .select('student_id, raice_students(id, first_name, last_name, course_id, raice_courses(grade, number))')
      .eq('subgroup_course_id', subgroup_id);
    if (error) return res.status(500).json({ error: 'Error al cargar miembros' });
    const list = (members || []).map(m => ({
      student_id:    m.student_id,
      first_name:    m.raice_students?.first_name || '',
      last_name:     m.raice_students?.last_name  || '',
      course_grade:  m.raice_students?.raice_courses?.grade,
      course_number: m.raice_students?.raice_courses?.number,
    })).sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
    );
    return res.status(200).json({ members: list });
  }

  if (req.method === 'POST') {
    const { subgroup_id, student_id, student_ids } = req.body || {};
    if (!subgroup_id) return res.status(400).json({ error: 'subgroup_id requerido' });

    // ── Bulk insert ──
    if (Array.isArray(student_ids) && student_ids.length) {
      const { data: crs } = await sb.from('raice_courses').select('type').eq('id', subgroup_id).maybeSingle();
      if (crs?.type !== 'subgroup') return res.status(400).json({ error: 'El curso indicado no es un subgrupo' });
      const rows = student_ids.map(id => ({ subgroup_course_id: subgroup_id, student_id: id }));
      const { error } = await sb.from('raice_subgroup_members').insert(rows);
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Uno o más estudiantes ya son miembros de este subgrupo' });
        return res.status(500).json({ error: 'Error al agregar miembros' });
      }
      return res.status(200).json({ success: true, added: student_ids.length });
    }

    // ── Single insert ──
    if (!student_id) return res.status(400).json({ error: 'student_id requerido' });
    const { data: crs } = await sb.from('raice_courses').select('type').eq('id', subgroup_id).maybeSingle();
    if (crs?.type !== 'subgroup') return res.status(400).json({ error: 'El curso indicado no es un subgrupo' });
    const { error } = await sb.from('raice_subgroup_members').insert({ subgroup_course_id: subgroup_id, student_id });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'El estudiante ya es miembro de este subgrupo' });
      return res.status(500).json({ error: 'Error al agregar miembro' });
    }
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { subgroup_id, student_id } = req.body || {};
    if (!subgroup_id || !student_id) return res.status(400).json({ error: 'subgroup_id y student_id requeridos' });
    const { error } = await sb.from('raice_subgroup_members').delete()
      .eq('subgroup_course_id', subgroup_id).eq('student_id', student_id);
    if (error) return res.status(500).json({ error: 'Error al eliminar miembro' });
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// COURSE DAY SCHEDULE — teacher evasion investigation
// Returns all schedule slots for a course on a given date,
// optionally enriched with a specific student's per-hour attendance.
// =====================================================
async function getCourseDaySchedule(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id  = url.searchParams.get('course_id');
  const date       = url.searchParams.get('date') || todayCO();
  const student_id = url.searchParams.get('student_id');

  if (!course_id) return res.status(400).json({ error: 'course_id requerido' });

  // Compute day-of-week (1=Mon … 7=Sun) for the requested date
  const d = new Date(date + 'T12:00:00');
  const jsDay = d.getDay(); // 0=Sun
  const dayNum = jsDay === 0 ? 7 : jsDay;

  // Get all teacher_course IDs for this course
  const { data: tcRows } = await sb.from('raice_teacher_courses')
    .select('id').eq('course_id', course_id);
  const tcIds = (tcRows || []).map(r => r.id);

  if (!tcIds.length) return res.status(200).json({ hours: [] });

  // Get schedules for those tc IDs on the given day of week
  const { data: schedRows } = await sb.from('raice_schedules')
    .select(`
      class_hour, start_time, end_time, teacher_course_id,
      raice_teacher_courses(
        subject,
        raice_users(first_name, last_name),
        raice_courses(name)
      )
    `)
    .in('teacher_course_id', tcIds)
    .eq('day_of_week', dayNum)
    .order('class_hour');

  // Bell schedule fallback for start/end times
  const { data: bellRows } = await sb.from('raice_bell_schedule')
    .select('class_hour, start_time, end_time').order('class_hour');
  const bellMap = {};
  (bellRows || []).forEach(b => { bellMap[b.class_hour] = b; });

  // Student's per-hour attendance for this course+date (if student_id provided)
  const attMap = {}; // class_hour → status
  if (student_id) {
    const { data: attRows } = await sb.from('raice_attendance')
      .select('class_hour, status')
      .eq('course_id', course_id)
      .eq('date', date)
      .eq('student_id', student_id);
    (attRows || []).forEach(a => { attMap[a.class_hour] = a.status; });
  }

  // Deduplicate by class_hour (take first in case of overlapping schedules)
  const seen = new Set();
  const hours = [];
  for (const s of (schedRows || [])) {
    if (seen.has(s.class_hour)) continue;
    seen.add(s.class_hour);
    const tc   = s.raice_teacher_courses;
    const bell = bellMap[s.class_hour] || {};
    hours.push({
      class_hour:     s.class_hour,
      start_time:     s.start_time || bell.start_time || null,
      end_time:       s.end_time   || bell.end_time   || null,
      teacher_name:   tc?.raice_users
        ? `${tc.raice_users.first_name} ${tc.raice_users.last_name}` : '—',
      subject:        tc?.subject || tc?.raice_courses?.name || null,
      student_status: student_id ? (attMap[s.class_hour] ?? null) : undefined,
    });
  }

  return res.status(200).json({ hours, date });
}

// =====================================================
// MY COURSES (Teacher)
// =====================================================

async function getMyCourses(req, res, user) {
  const sb    = getSupabase();
  const today  = todayCO();
  const dayNum = dayOfWeekCO(today); // 1=Mon ... 7=Sun, matches raice_schedules.day_of_week

  const { data: tc } = await sb.from('raice_teacher_courses')
    .select('id, course_id, subject, raice_courses(id, grade, number, section, type, name)')
    .eq('teacher_id', user.id);

  // Load all schedules for this teacher in one query
  const tcIds = (tc || []).map(r => r.id).filter(Boolean);
  let scheduleMap = {}; // tc_id → [schedule rows]
  if (tcIds.length) {
    const { data: schedRows } = await sb.from('raice_schedules')
      .select('teacher_course_id, day_of_week, class_hour, start_time, end_time')
      .in('teacher_course_id', tcIds);
    (schedRows || []).forEach(s => {
      if (!scheduleMap[s.teacher_course_id]) scheduleMap[s.teacher_course_id] = [];
      scheduleMap[s.teacher_course_id].push(s);
    });
  }

  // Load active suspensions for all students in this teacher's courses
  const { data: suspRows } = await sb.from('raice_suspensions')
    .select('student_id, start_date, end_date, reason')
    .lte('start_date', today).gte('end_date', today);
  const suspendedMap = {}; // student_id → suspension info
  (suspRows || []).forEach(s => { suspendedMap[s.student_id] = s; });

  // Load bell schedule to fill start/end times when raice_schedules lacks them
  const { data: bellRows } = await sb.from('raice_bell_schedule')
    .select('class_hour, start_time, end_time').order('class_hour');
  const bellMap = {};
  (bellRows || []).forEach(b => { bellMap[b.class_hour] = b; });

  const courseIds         = (tc || []).map(r => r.raice_courses?.id).filter(Boolean);
  const normalCourseIds   = (tc || []).filter(r => r.raice_courses?.type !== 'subgroup').map(r => r.raice_courses?.id).filter(Boolean);
  const subgroupCourseIds = (tc || []).filter(r => r.raice_courses?.type === 'subgroup').map(r => r.raice_courses?.id).filter(Boolean);

  // Batch: students counts, today's attendance, and subgroup member counts
  const [studentsAll, attAll, subgroupMembersAll] = await Promise.all([
    normalCourseIds.length
      ? sb.from('raice_students').select('course_id').eq('status', 'active').in('course_id', normalCourseIds)
      : { data: [] },
    courseIds.length
      ? sb.from('raice_attendance').select('student_id, status, class_hour, course_id, teacher_id').in('course_id', courseIds).eq('date', today)
      : { data: [] },
    subgroupCourseIds.length
      ? sb.from('raice_subgroup_members').select('subgroup_course_id').in('subgroup_course_id', subgroupCourseIds)
      : { data: [] }
  ]);

  const studentCountMap = {};
  (studentsAll.data || []).forEach(s => {
    studentCountMap[s.course_id] = (studentCountMap[s.course_id] || 0) + 1;
  });
  (subgroupMembersAll.data || []).forEach(m => {
    studentCountMap[m.subgroup_course_id] = (studentCountMap[m.subgroup_course_id] || 0) + 1;
  });

  // Attendance map: course_id → class_hour → { present, total, hasRealList }
  // hasRealList = at least one P, A, T or S (not just PE from excusas)
  const attByCourse = {};
  (attAll.data || []).forEach(a => {
    if (!attByCourse[a.course_id]) attByCourse[a.course_id] = {};
    if (!attByCourse[a.course_id][a.class_hour]) attByCourse[a.course_id][a.class_hour] = { present: 0, total: 0, hasRealList: false, teacherId: null };

    attByCourse[a.course_id][a.class_hour].total++;
    if (a.status === 'P' || a.status === 'PE') attByCourse[a.course_id][a.class_hour].present++;
    if (a.status === 'P' || a.status === 'A' || a.status === 'T' || a.status === 'S') {
      attByCourse[a.course_id][a.class_hour].hasRealList = true;
      if (!attByCourse[a.course_id][a.class_hour].teacherId && a.teacher_id) attByCourse[a.course_id][a.class_hour].teacherId = a.teacher_id;
    }
  });

  const courses = (tc || []).map(row => {
    const c = row.raice_courses;
    if (!c) return null;

    const courseAttMap = attByCourse[c.id] || {};
    const studentsInCourse = studentCountMap[c.id] || 0;

    // All hours where any teacher actually took attendance (not just PE from excusas)
    const allSavedHours = Object.keys(courseAttMap)
      .filter(h => courseAttMap[h].hasRealList)
      .map(Number);

    // saved_hours: all hours where attendance has been saved (by this teacher, replacement, or coordinator)
    const savedHours = allSavedHours;

    // Map: hour → teacher_id who saved it (for "copy from prev hour" UI — needs ALL hours)
    const savedHoursBy = {};
    allSavedHours.forEach(h => { savedHoursBy[h] = courseAttMap[h]?.teacherId || null; });

    // Per-hour attendance percentage
    const pctByHour = {};
    Object.entries(courseAttMap).forEach(([hour, v]) => {
      pctByHour[Number(hour)] = v.hasRealList && v.total > 0 ? Math.round((v.present / v.total) * 100) : null;
    });

    // Today's schedule for this assignment
    const allSlots = scheduleMap[row.id] || [];
    const todaySlots = allSlots
      .filter(s => s.day_of_week === dayNum)
      .sort((a, b) => a.class_hour - b.class_hour)
      .map(s => {
        // Fill start/end from bell schedule when not set in raice_schedules
        const bell = bellMap[s.class_hour] || {};
        return {
          ...s,
          start_time: s.start_time || bell.start_time || null,
          end_time:   s.end_time   || bell.end_time   || null,
          attendance_pct: pctByHour[s.class_hour] ?? null,
        };
      });
    const weekSlots = [...allSlots].sort((a,b) => a.day_of_week - b.day_of_week || a.class_hour - b.class_hour);
    const hasClassToday = todaySlots.length > 0;
    const pendingHours = todaySlots
      .filter(s => !savedHours.includes(s.class_hour))
      .map(s => s.class_hour);

    return {
      id: c.id, grade: c.grade, number: c.number,
      type: c.type || 'normal', name: c.name || null,
      section: c.section || (c.type === 'subgroup' ? (c.name || 'Subgrupo') : String(c.number)),
      subject: row.subject || '',
      teacher_course_id: row.id,
      students_count: studentCountMap[c.id] || 0,
      saved_hours: savedHours,
      saved_hours_by: savedHoursBy,
      has_class_today: hasClassToday,
      pending_hours: pendingHours,
      today_slots: todaySlots,
      week_slots: weekSlots,
      suspended_map: suspendedMap  // student_id → suspension for this course's students
    };
  });

  return res.status(200).json({ courses: courses.filter(Boolean) });
}

// =====================================================
// ASISTENCIA FALTANTE — clases sin registro para una fecha
// =====================================================
async function getMissingAttendance(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || todayCO();
  const dayNum = dayOfWeekCO(date); // 1=Lun … 7=Dom

  // 1. Todos los horarios programados para ese día de la semana
  const { data: schedRows } = await sb
    .from('raice_schedules')
    .select('class_hour, teacher_course_id')
    .eq('day_of_week', dayNum);

  if (!schedRows?.length) return res.status(200).json({ missing: [], date });

  const tcIds = [...new Set(schedRows.map(s => s.teacher_course_id).filter(Boolean))];

  // 2. Información de cada asignación docente-curso
  const { data: tcRows } = await sb
    .from('raice_teacher_courses')
    .select('id, course_id, subject, teacher_id')
    .in('id', tcIds);

  const tcMap = {};
  (tcRows || []).forEach(tc => { tcMap[tc.id] = tc; });

  const allowedCourseIds = await getAllowedCourseIdsForAdmin(sb, user);
  const allowedSet = allowedCourseIds ? new Set(allowedCourseIds) : null;

  // 3. Detalle de cursos y docentes
  let courseIds  = [...new Set((tcRows||[]).map(r => r.course_id).filter(Boolean))];
  if (allowedSet) courseIds = courseIds.filter(id => allowedSet.has(id));

  const teacherIds = [...new Set((tcRows||[]).map(r => r.teacher_id).filter(Boolean))];

  const [{ data: courseRows }, { data: teacherRows }] = await Promise.all([
    sb.from('raice_courses').select('id, grade, number').in('id', courseIds),
    sb.from('raice_users').select('id, first_name, last_name').in('id', teacherIds),
  ]);

  const courseMap  = {};
  const teacherMap = {};
  (courseRows  || []).forEach(c => { courseMap[c.id]  = c; });
  (teacherRows || []).forEach(t => { teacherMap[t.id] = `${t.first_name} ${t.last_name}`; });

  // 4. Registros de asistencia que SÍ existen para esa fecha
  // Excluir PE (excusas) y NR — solo lista real cuenta como "registrada"
  const { data: attRows } = await sb
    .from('raice_attendance')
    .select('course_id, class_hour, status')
    .eq('date', date);

  // Set de claves "course_id::class_hour" que ya tienen registro real
  const savedSet = new Set((attRows || [])
    .filter(r => r.status !== 'PE' && r.status !== 'NR')
    .map(r => `${r.course_id}::${r.class_hour}`));

  // 5. Cruzar: sesiones programadas sin registro
  const missing = [];
  schedRows.forEach(s => {
    const tc = tcMap[s.teacher_course_id];
    if (!tc) return;
    if (allowedSet && !allowedSet.has(tc.course_id)) return;
    const key = `${tc.course_id}::${s.class_hour}`;
    if (savedSet.has(key)) return; // ya registrada
    const course  = courseMap[tc.course_id]  || {};
    missing.push({
      course_id:   tc.course_id,
      grade:       course.grade  ?? '?',
      course_num:  course.number ?? '?',
      subject:     tc.subject    || '—',
      teacher:     teacherMap[tc.teacher_id] || '—',
      class_hour:  s.class_hour,
      date,
    });
  });

  // Ordenar por grado, curso, hora
  missing.sort((a, b) =>
    a.grade - b.grade || a.course_num - b.course_num || a.class_hour - b.class_hour
  );

  return res.status(200).json({ missing, date, count: missing.length });
}

// =====================================================
// ATTENDANCE
// =====================================================

async function handleAttendance(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { course_id, date, class_hour, records, activity_note } = req.body || {};
    if (!course_id || !date || !records?.length) return res.status(400).json({ error: 'Datos incompletos' });

    const hour = parseInt(class_hour) || 1;

    // Validate that this teacher is assigned to this course
    if (user.role === 'teacher') {
      // A teacher may teach multiple subjects in the same course → multiple rows
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id').eq('teacher_id', user.id).eq('course_id', course_id);
      if (!tcRows || !tcRows.length) {
        return res.status(403).json({ error: 'No tienes acceso a este curso' });
      }
      // Validate hour against schedule.
      // If raice_schedules table does not exist yet (migration pending),
      // skip validation so attendance can still be saved.
      try {
        const tcIds     = tcRows.map(r => r.id);
        const dayOfWeek = dayOfWeekCO(date);

        // Fetch schedules for ALL teacher_course rows of this teacher+course
        const { data: schedRows, error: schedErr } = await sb.from('raice_schedules')
          .select('class_hour').in('teacher_course_id', tcIds).eq('day_of_week', dayOfWeek);

        if (!schedErr) {
          const scheduledHours = (schedRows || []).map(s => s.class_hour);
          if (scheduledHours.length === 0) {
            // No schedule for today — check if ANY schedule exists for this teacher+course at all
            const { data: anyRows } = await sb.from('raice_schedules')
              .select('id').in('teacher_course_id', tcIds).limit(1);
            if (anyRows && anyRows.length > 0) {
              // Schedules exist for other days but not today → block
              return res.status(403).json({ error: 'Este docente no tiene clase hoy con este curso según el horario configurado.' });
            }
            // No schedule at all for this teacher+course → allow (school hasn't set up schedules yet)
          } else if (!scheduledHours.includes(hour)) {
            return res.status(403).json({ error: `No tienes clase en la ${hour}ª hora con este curso` });
          }
        }
      } catch (_) { /* tabla no disponible, permitir guardado */ }

      // Fix 2: bloquear guardado si es fecha pasada (fechas distintas al día actual en Colombia)
      const today = todayCO();
      if (date !== today) {
        return res.status(423).json({ error: 'Solo puedes registrar asistencia del día actual.' });
      }

      // Fix 3: verificar ownership y ventana de corrección si ya existen registros
      const { data: existingRec } = await sb.from('raice_attendance')
        .select('id, teacher_id, created_at')
        .eq('course_id', course_id).eq('date', date).eq('class_hour', hour)
        .not('teacher_id', 'is', null)
        .limit(1).maybeSingle();
      if (existingRec) {
        if (existingRec.teacher_id !== user.id) {
          return res.status(403).json({ error: 'Esta asistencia fue registrada por otro docente. Solo el coordinador puede corregirla.' });
        }
        // Verificar ventana de corrección configurada en raice_config
        const { data: cfgData } = await sb.from('raice_config')
          .select('correction_window, correction_window_minutes, correction_window_hour')
          .eq('id', 1).maybeSingle();
        const windowType    = cfgData?.correction_window         || 'same_day_end';
        const windowMinutes = cfgData?.correction_window_minutes || 55;
        const windowHour    = cfgData?.correction_window_hour    || '23:59';
        let deadline;
        if (windowType === 'class_duration') {
          const { data: bellRow } = await sb.from('raice_bell_schedule')
            .select('end_time').eq('class_hour', hour).maybeSingle();
          if (bellRow?.end_time) {
            const [ch, cm] = bellRow.end_time.split(':');
            // Build deadline as Colombia local time then convert to UTC (+5h)
            deadline = new Date(`${date}T${String(parseInt(ch)).padStart(2,'0')}:${String(parseInt(cm)).padStart(2,'0')}:00.000Z`);
            deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
          } else {
            // Fallback: N minutos desde el guardado
            deadline = new Date(new Date(existingRec.created_at).getTime() + windowMinutes * 60000);
          }
        } else if (windowType === 'same_day_hour') {
          // windowHour is a Colombia local time string like "17:00"
          const wh = String(windowHour || '23:59').padStart(5, '0');
          const [wHH, wMM] = wh.split(':').map(Number);
          // Interpret as Colombia time (UTC-5): add 5 hours to get UTC
          deadline = new Date(`${date}T${String(wHH).padStart(2,'0')}:${String(wMM).padStart(2,'0')}:00.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else if (windowType === 'next_day_end') {
          // Day after list date at 23:59:59 Colombia time → UTC
          const nextDay = (() => {
            const d = new Date(date + 'T12:00:00');
            d.setDate(d.getDate() + 1);
            return d.toISOString().slice(0, 10);
          })();
          deadline = new Date(`${nextDay}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else { // same_day_end (default)
          // 23:59:59 Colombia time = next day 04:59:59 UTC
          deadline = new Date(`${date}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        }
        if (deadline && new Date() > deadline) {
          return res.status(403).json({ error: 'La ventana de corrección cerró. Solicita al coordinador que haga la corrección.' });
        }
      }
    }

    // Try to delete with class_hour; if column doesn't exist, delete without it
    // For coordinator corrections: preserve the original teacher_id so trazabilidad is maintained
    let originalTeacherId = user.id;
    let prevTardyIds  = new Set();
    let prevAbsentIds = new Set();

    // Capture previous A-status students for ALL roles — needed to retract evasion notifications
    {
      const { data: prevA } = await sb.from('raice_attendance')
        .select('student_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).eq('status', 'A');
      (prevA || []).forEach(r => prevAbsentIds.add(r.student_id));
    }

    if (['superadmin', 'admin'].includes(user.role)) {
      // Look up who originally recorded this hour so we preserve their teacher_id
      const { data: origRow } = await sb.from('raice_attendance')
        .select('teacher_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).limit(1);
      if (origRow && origRow[0]?.teacher_id) {
        originalTeacherId = origRow[0].teacher_id;
      } else {
        // No prior record (e.g. the titular teacher was absent and the coordinator
        // is taking attendance for the first time). Attribute it to the scheduled
        // teacher from the timetable so the slot is owned by the titular, not the
        // coordinator — keeps the school map and ownership checks consistent.
        try {
          const dow = dayOfWeekCO(date);
          const { data: schedRow } = await sb.from('raice_schedules')
            .select('raice_teacher_courses!inner(teacher_id, course_id)')
            .eq('class_hour', hour).eq('day_of_week', dow)
            .eq('raice_teacher_courses.course_id', course_id)
            .limit(1);
          const titularId = schedRow?.[0]?.raice_teacher_courses?.teacher_id;
          if (titularId) originalTeacherId = titularId;
        } catch (_) { /* tabla de horarios no disponible — usar el coordinador */ }
      }

      // Capture students with T status before overwriting — needed to clean up notifications
      const { data: prevT } = await sb.from('raice_attendance')
        .select('student_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).eq('status', 'T');
      (prevT || []).forEach(r => prevTardyIds.add(r.student_id));
    }

    const delResult = await sb.from('raice_attendance').delete()
      .eq('course_id', course_id).eq('date', date).eq('class_hour', hour);
    if (delResult.error && delResult.error.message.includes('class_hour')) {
      // Column doesn't exist yet — delete by date+course only
      await sb.from('raice_attendance').delete().eq('course_id', course_id).eq('date', date);
    }

    // Try to insert with class_hour; if column doesn't exist, insert without it
    const isAllS = records.every(r => r.status === 'S');
    const noteValue = (isAllS && activity_note) ? String(activity_note).slice(0, 200) : null;
    const rows = records.map(r => ({
      student_id: r.student_id,
      course_id,
      teacher_id: originalTeacherId, // preserve original teacher; coordinator id goes to audit log
      date,
      class_hour: hour,
      status: ['P','A','PE','T','S'].includes(r.status) ? r.status : 'P',
      activity_note: noteValue
    }));

    let { error } = await sb.from('raice_attendance').insert(rows);
    if (error && error.message.includes('activity_note')) {
      // Column doesn't exist yet — retry without it
      const rowsNoNote = rows.map(r => { const { activity_note: _, ...rest } = r; return rest; });
      const res1 = await sb.from('raice_attendance').insert(rowsNoNote);
      error = res1.error;
    }
    if (error && (error.message.includes('class_hour') || error.message.includes('status'))) {
      // Fallback: insert without class_hour, map T→PE for old schema
      const fallbackRows = records.map(r => ({
        student_id: r.student_id,
        course_id,
        teacher_id: originalTeacherId,
        date,
        status: r.status === 'T' ? 'PE' : (['P','A','PE'].includes(r.status) ? r.status : 'P')
      }));
      const res2 = await sb.from('raice_attendance').insert(fallbackRows);
      error = res2.error;
    }
    if (error) return res.status(500).json({ error: _dbErr(error, '') });

    // Auto-ausencia para estudiantes desertores de este curso
    try {
      // Curso regular: desertores con course_id directo
      const { data: desertoresReg } = await sb.from('raice_students')
        .select('id').eq('course_id', course_id).eq('status', 'desertor');
      let desertorIds = (desertoresReg || []).map(s => s.id);

      // Subgrupo: miembros desertores
      const { data: subMembers } = await sb.from('raice_subgroup_members')
        .select('student_id').eq('subgroup_course_id', course_id);
      if (subMembers?.length) {
        const memberIds = subMembers.map(m => m.student_id);
        const { data: desertoresMiembros } = await sb.from('raice_students')
          .select('id').in('id', memberIds).eq('status', 'desertor');
        desertorIds = [...new Set([...desertorIds, ...(desertoresMiembros || []).map(s => s.id)])];
      }

      // Excluir IDs ya presentes en los records enviados por el docente
      const submittedIds = new Set(records.map(r => r.student_id));
      desertorIds = desertorIds.filter(id => !submittedIds.has(id));

      if (desertorIds.length > 0) {
        const desertorRows = desertorIds.map(sid => ({
          student_id: sid, course_id, teacher_id: null, date, class_hour: hour, status: 'A'
        }));
        await sb.from('raice_attendance').insert(desertorRows);
      }
    } catch (_) { /* no crítico */ }

    // Coordinator correction — audit log only, skip tardanza/evasion notifications
    if (['superadmin', 'admin'].includes(user.role)) {
      const { data: courseInfo } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();
      const g = courseInfo?.grade || '?', n = courseInfo?.number || '?';

      // Remove tardanza notifications for students corrected away from T
      const removedTardy = records
        .filter(r => prevTardyIds.has(r.student_id) && r.status !== 'T')
        .map(r => r.student_id);
      if (removedTardy.length > 0) {
        await sb.from('raice_notifications')
          .delete()
          .eq('type', 'tardanza')
          .in('link_id', removedTardy)
          .like('body', `%${date}%`);
      }

      // Reevaluar evasiones de forma robusta para todos los estudiantes modificados en la corrección
      const studentIds = records.map(r => r.student_id);
      await reevaluateEvasions(sb, course_id, date, studentIds);


      await logActivity(sb, user.id, 'attendance_correction',
        `Corrección de asistencia — ${g}°${n} — ${hour}ª hora — ${date} — por @${user.username}`);
      return res.status(200).json({ success: true, saved: rows.length, corrected_by: user.username });
    }

    // Process tardanzas — notify coordinators
    const tardes = records.filter(r => r.status === 'T');
    if (tardes.length > 0) {
      const { data: courseData } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();
      const grade  = courseData?.grade  || '?';
      const number = courseData?.number || '?';
      const { data: studentData } = await sb.from('raice_students')
        .select('id, first_name, last_name').in('id', tardes.map(t => t.student_id));
      const studentMap = {};
      (studentData || []).forEach(s => studentMap[s.id] = `${s.first_name} ${s.last_name}`);
      const { data: admins } = await sb.from('raice_users')
        .select('id').eq('role', 'admin').eq('active', true);
      const ordinals = ['1ª','2ª','3ª','4ª','5ª','6ª','7ª','8ª'];
      const hourLabel = ordinals[hour-1] || hour + 'ª';
      for (const t of tardes) {
        const studentName = studentMap[t.student_id] || 'Estudiante';
        for (const admin of (admins || [])) {
          await sendNotification(sb, admin.id, user.id, 'tardanza',
            `⏰ Tardanza — ${studentName}`,
            `${grade}°${number} · ${hourLabel} hora · ${date}`,
            t.student_id
          );
        }
      }
      await logActivity(sb, user.id, 'tardanza',
        `${tardes.length} tardanza(s) en ${grade}°${number} — ${hourLabel} hora — ${date}`);
    }

    // ---- DETECCIÓN DE EVASIÓN ----
    // Si esta es hora >= 2, buscar estudiantes que en una hora anterior
    // estuvieron PRESENTES (P) pero ahora están AUSENTES (A)
    let evasiones = 0;
    let evadidosInfo = []; // populated below, returned to frontend for teacher panel
    if (hour >= 2) {
      const absentesAhora = records.filter(r => r.status === 'A').map(r => r.student_id);
      if (absentesAhora.length > 0) {
        // Obtener registros de horas anteriores del mismo día/curso
        // Incluir teacher_id para saber quién registró la hora anterior
        const { data: prevAtt } = await sb.from('raice_attendance')
          .select('student_id, status, class_hour, teacher_id')
          .eq('course_id', course_id)
          .eq('date', date)
          .lt('class_hour', hour)
          .in('student_id', absentesAhora);

        // Estudiantes que SÍ estuvieron presentes en alguna hora anterior
        // y mapa de estudiante -> docente que registró esa hora
        const presentesAntes = new Set();
        const prevTeacherMap = {}; // student_id -> teacher_id de la hora anterior con P
        (prevAtt || []).forEach(r => {
          if (r.status === 'P') {
            presentesAntes.add(r.student_id);
            // Guardar el teacher_id de la hora más reciente con P
            if (!prevTeacherMap[r.student_id] || r.class_hour > (prevTeacherMap[r.student_id].hour || 0)) {
              prevTeacherMap[r.student_id] = { teacherId: r.teacher_id, hour: r.class_hour };
            }
          }
        });

        const evadidos = absentesAhora.filter(sid => presentesAntes.has(sid));

        if (evadidos.length > 0) {
          const { data: courseData2 } = await sb.from('raice_courses')
            .select('grade, number, director_id').eq('id', course_id).single();
          const grade2  = courseData2?.grade  || '?';
          const number2 = courseData2?.number || '?';

          const { data: studentData2 } = await sb.from('raice_students')
            .select('id, first_name, last_name').in('id', evadidos);
          const studentMap2 = {};
          (studentData2 || []).forEach(s => studentMap2[s.id] = `${s.first_name} ${s.last_name}`);

          const { data: admins2 } = await sb.from('raice_users')
            .select('id').eq('role', 'admin').eq('active', true);

          const ordinals2 = ['1ª','2ª','3ª','4ª','5ª','6ª','7ª','8ª'];
          const hourLabel2 = ordinals2[hour-1] || hour + 'ª';
          const prevHourLabel = ordinals2[hour-2] || (hour-1) + 'ª';

          // Look up names of previous-hour teachers in one batch
          const prevTIds = [...new Set(evadidos.map(sid => prevTeacherMap[sid]?.teacherId).filter(Boolean))];
          const prevTNameMap = {};
          if (prevTIds.length) {
            const { data: ptRows } = await sb.from('raice_users')
              .select('id, first_name, last_name').in('id', prevTIds);
            (ptRows||[]).forEach(t => prevTNameMap[t.id] = `${t.first_name} ${t.last_name}`);
          }

          // Notificar a cada estudiante evadido
          for (const sid of evadidos) {
            const studentName = studentMap2[sid] || 'Estudiante';
            const titulo = `🚨 Posible evasión — ${studentName}`;
            const prevTId   = prevTeacherMap[sid]?.teacherId;
            const prevTName = prevTId ? (prevTNameMap[prevTId] || '') : '';
            const cuerpo  = `${grade2}°${number2} · Estaba en ${prevHourLabel} hora${prevTName ? ' con '+prevTName : ''}, ausente en ${hourLabel2} hora · ${date}`;
            evadidosInfo.push({ student_id: sid, student_name: studentName, body: cuerpo });

            // 1. Notificar a todos los coordinadores
            for (const admin of (admins2 || [])) {
              await sendNotification(sb, admin.id, user.id, 'evasion', titulo, cuerpo, sid);
            }
            // 2. Notificar al director de grado si existe y es distinto del docente actual
            if (courseData2?.director_id && courseData2.director_id !== user.id) {
              await sendNotification(sb, courseData2.director_id, user.id, 'evasion', titulo, cuerpo, sid);
            }
            // 3. Notificar al docente que registró la hora anterior (si es distinto al actual)
            const prevTeacherId = prevTeacherMap[sid]?.teacherId;
            if (prevTeacherId && prevTeacherId !== user.id) {
              await sendNotification(sb, prevTeacherId, user.id, 'evasion', titulo, cuerpo, sid);
            }
            evasiones++;
          }
          await logActivity(sb, user.id, 'evasion',
            `${evadidos.length} posible(s) evasión en ${grade2}°${number2} — ${hourLabel2} hora — ${date}`);
        }
      }
    }

    // Reevaluar evasiones de forma robusta para todos los estudiantes modificados en el guardado del docente
    const studentIds = records.map(r => r.student_id);
    await reevaluateEvasions(sb, course_id, date, studentIds);


    await logActivity(sb, user.id, 'attendance',
      `Asistencia ${hour}ª hora — Curso ${course_id} — ${date}`);
    return res.status(200).json({ success: true, saved: rows.length, tardes: tardes.length, evasiones, evadidos: evadidosInfo });
  }

  if (req.method === 'GET') {
    requireRole(user, 'superadmin', 'admin');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const date_from = url.searchParams.get('date_from');
    const date_to   = url.searchParams.get('date_to');

    // ── RANGE MODE (semana / mes / período / año) ────────────────────
    const allowedCourseIds = await getAllowedCourseIdsForAdmin(sb, user);

    if (date_from && date_to) {
      let query = sb.from('raice_attendance')
        .select('status, course_id, class_hour, student_id, teacher_id, date')
        .gte('date', date_from).lte('date', date_to);
      if (allowedCourseIds) query = query.in('course_id', allowedCourseIds);
      const { data: attData } = await query;

      // Deduplicate: per student + course + date → keep last hour's status
      const scdMap = {};
      (attData||[]).forEach(r => {
        const key = `${r.student_id}_${r.course_id}_${r.date}`;
        if (!scdMap[key] || r.class_hour > scdMap[key].class_hour) scdMap[key] = r;
      });
      const deduped = Object.values(scdMap);

      const present = deduped.filter(r => r.status === 'P').length;
      const absent  = deduped.filter(r => r.status === 'A').length;
      const permit  = deduped.filter(r => r.status === 'PE').length;
      const late    = deduped.filter(r => r.status === 'T').length;

      // Course + director de grupo lookups
      const cIds = [...new Set(deduped.map(r => r.course_id).filter(Boolean))];
      const courseMap2 = {};
      if (cIds.length) {
        const { data: cr } = await sb.from('raice_courses').select('id,grade,number,name,type,director_id').in('id', cIds);
        (cr||[]).forEach(c => courseMap2[c.id] = c);
      }
      // Fetch director names
      const dirIds = [...new Set(Object.values(courseMap2).map(c => c.director_id).filter(Boolean))];
      const dirMap = {};
      if (dirIds.length) {
        const { data: dr } = await sb.from('raice_users').select('id,first_name,last_name').in('id', dirIds);
        (dr||[]).forEach(d => dirMap[d.id] = `${d.first_name} ${d.last_name}`);
      }

      const byCourse = {};
      deduped.forEach(r => {
        if (!r.course_id) return;
        if (!byCourse[r.course_id]) {
          const c = courseMap2[r.course_id] || {};
          byCourse[r.course_id] = {
            course_id: r.course_id,
            grade: c.grade ?? '?', course: c.number ?? c.name ?? '?',
            teacher: dirMap[(courseMap2[r.course_id] || {}).director_id] || '—',
            present:0, absent:0, late:0, permit:0, total:0
          };
        }
        byCourse[r.course_id].total++;
        const s = r.status;
        if (s==='P'||s==='S') byCourse[r.course_id].present++;
        else if (s==='PE')    { byCourse[r.course_id].present++; byCourse[r.course_id].permit++; }
        else if (s==='A')      byCourse[r.course_id].absent++;
        else if (s==='T')      byCourse[r.course_id].late++;
      });
      const courses = Object.values(byCourse)
        .map(c => ({ ...c, pct: c.total>0 ? Math.round((c.present/c.total)*100) : 0 }))
        .sort((a,b) => a.grade - b.grade || a.course - b.course);

      return res.status(200).json({ present, absent, permit, late, courses, mode: 'range' });
    }

    // ── DAY MODE (comportamiento original intacto) ───────────────────
    const date = url.searchParams.get('date') || todayCO();
    const full = url.searchParams.get('full') === 'true';

    // ── FULL LIST MODE (lista completa estudiante × hora) ────────────
    if (full) {
      let queryRaw = sb.from('raice_attendance')
        .select('student_id, class_hour, status, course_id, teacher_id')
        .eq('date', date);
      if (allowedCourseIds) queryRaw = queryRaw.in('course_id', allowedCourseIds);
      const { data: rawData } = await queryRaw;

      if (!rawData?.length) return res.status(200).json({ hours: [], students: [] });

      const stuIds = [...new Set(rawData.map(r => r.student_id).filter(Boolean))];
      const cIds   = [...new Set(rawData.map(r => r.course_id).filter(Boolean))];
      const tIds   = [...new Set(rawData.map(r => r.teacher_id).filter(Boolean))];

      const [stuRes, crsRes, tchRes, tcRes] = await Promise.all([
        stuIds.length ? sb.from('raice_students').select('id,first_name,last_name').in('id', stuIds) : Promise.resolve({ data: [] }),
        cIds.length   ? sb.from('raice_courses').select('id,grade,number').in('id', cIds)           : Promise.resolve({ data: [] }),
        tIds.length   ? sb.from('raice_users').select('id,first_name,last_name').in('id', tIds)     : Promise.resolve({ data: [] }),
        tIds.length && cIds.length
          ? sb.from('raice_teacher_courses').select('teacher_id,course_id,subject').in('teacher_id', tIds).in('course_id', cIds)
          : Promise.resolve({ data: [] }),
      ]);

      const stuMap = {};
      (stuRes.data||[]).forEach(s => stuMap[s.id] = `${s.last_name}, ${s.first_name}`);
      const cMap = {};
      (crsRes.data||[]).forEach(c => cMap[c.id] = c);
      const tchMap = {};
      (tchRes.data||[]).forEach(t => tchMap[t.id] = `${t.first_name} ${t.last_name}`);
      // teacher+course → subject
      const tcSubjectMap = {};
      (tcRes.data||[]).forEach(tc => { tcSubjectMap[`${tc.teacher_id}_${tc.course_id}`] = tc.subject || ''; });

      const hours = [...new Set(rawData.map(r => r.class_hour).filter(h => h != null))].sort((a,b) => a - b);

      const byStudent = {};
      rawData.forEach(r => {
        if (!r.student_id) return;
        if (!byStudent[r.student_id]) {
          const c = cMap[r.course_id] || {};
          byStudent[r.student_id] = {
            student_id: r.student_id,
            name: stuMap[r.student_id] || '—',
            grade: c.grade ?? '?',
            course: c.number ?? '?',
            course_id: r.course_id,
            by_hour: {},
            by_hour_info: {}
          };
        }
        byStudent[r.student_id].by_hour[r.class_hour] = r.status;
        if (r.teacher_id) {
          byStudent[r.student_id].by_hour_info[r.class_hour] = {
            teacher: tchMap[r.teacher_id] || '',
            subject: tcSubjectMap[`${r.teacher_id}_${r.course_id}`] || ''
          };
        }
      });

      const students = Object.values(byStudent)
        .sort((a,b) => (a.grade - b.grade) || String(a.course).localeCompare(String(b.course)) || a.name.localeCompare(b.name));

      return res.status(200).json({ hours, students });
    }

    // Get attendance without FK joins to avoid name issues
    let queryAtt = sb.from('raice_attendance')
      .select('status, course_id, class_hour, student_id, teacher_id').eq('date', date);
    if (allowedCourseIds) queryAtt = queryAtt.in('course_id', allowedCourseIds);
    const { data: attDataRaw } = await queryAtt;

    // Filter out PE records from course+hour where no teacher took real attendance
    const realListSet2 = new Set();
    (attDataRaw||[]).forEach(r => {
      if (r.status !== 'PE' && r.status !== 'NR') {
        realListSet2.add(`${r.course_id}_${r.class_hour}`);
      }
    });
    const attData = (attDataRaw||[]).filter(r => {
      if (r.status === 'PE') return realListSet2.has(`${r.course_id}_${r.class_hour}`);
      return true;
    });

    // Deduplicate: if a student has multiple hours, use the most recent status per student per course
    const studentCourseMap = {};
    attData.forEach(r => {
      const key = r.student_id + '_' + r.course_id;
      if (!studentCourseMap[key] || r.class_hour > studentCourseMap[key].class_hour) {
        studentCourseMap[key] = r;
      }
    });
    const deduped = Object.values(studentCourseMap);

    const present = deduped.filter(r => r.status === 'P').length;
    const absent  = deduped.filter(r => r.status === 'A').length;
    const permit  = deduped.filter(r => r.status === 'PE').length;
    const late    = deduped.filter(r => r.status === 'T').length;

    // Get course details + director de grupo
    const courseIds = [...new Set((attData||[]).map(r => r.course_id).filter(Boolean))];
    const courseMap = {};
    if (courseIds.length) {
      const { data: courseRows } = await sb.from('raice_courses')
        .select('id, grade, number, name, type, director_id').in('id', courseIds);
      (courseRows||[]).forEach(c => courseMap[c.id] = c);
    }

    // Get teacher names (for hour→teacher tooltips) + director names
    const teacherIds = [...new Set((attData||[]).map(r => r.teacher_id).filter(Boolean))];
    const directorIds = [...new Set(Object.values(courseMap).map(c => c.director_id).filter(Boolean))];
    const allUserIds = [...new Set([...teacherIds, ...directorIds])];
    const teacherMap = {};
    if (allUserIds.length) {
      const { data: teacherRows } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', allUserIds);
      (teacherRows||[]).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
    }

    // Build per-course hour→teacher from raw data (before deduplication)
    const courseHourTeacher = {};
    (attData||[]).forEach(r => {
      if (!r.course_id || !r.teacher_id || r.class_hour == null) return;
      if (!courseHourTeacher[r.course_id]) courseHourTeacher[r.course_id] = {};
      if (!courseHourTeacher[r.course_id][r.class_hour])
        courseHourTeacher[r.course_id][r.class_hour] = teacherMap[r.teacher_id] || '—';
    });

    const byCoursemap = {};
    deduped.forEach(r => {
      const key = r.course_id;
      if (!key) return; // skip orphan records with no course_id
      const c   = courseMap[key] || {};
      if (!byCoursemap[key]) byCoursemap[key] = {
        course_id: key,              // always present — guarantees Editar button renders
        grade:   c.grade  ?? '?',
        course:  c.number ?? c.name ?? key,   // subgroups use name instead of number
        teacher: teacherMap[(courseMap[key] || {}).director_id] || '—',
        present: 0, absent: 0, permit: 0, late: 0, total: 0
      };
      byCoursemap[key].total++;
      if (r.status === 'P')       byCoursemap[key].present++;
      else if (r.status === 'A')  byCoursemap[key].absent++;
      else if (r.status === 'T')  byCoursemap[key].late++;
      else                        byCoursemap[key].permit++;
    });

    const courses = Object.values(byCoursemap).map(c => {
      const hourMap = courseHourTeacher[c.course_id] || {};
      const teachers_by_hour = Object.entries(hourMap)
        .sort((a,b) => Number(a[0]) - Number(b[0]))
        .map(([h, name]) => ({ hour: Number(h), name }));
      // Include type so front-end can distinguish subgroups from normal courses
      const courseType = (courseMap[c.course_id] || {}).type || 'normal';
      return { ...c, type: courseType, teachers_by_hour, pct: c.total > 0 ? Math.round((c.present / c.total) * 100) : 0 };
    }).sort((a,b) => a.grade - b.grade || a.course - b.course);

    return res.status(200).json({ present, absent, permit, late, courses });
  }

  return res.status(405).end();
}

async function getAttendanceByCourse(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const date      = url.searchParams.get('date') || todayCO();
  const hour      = parseInt(url.searchParams.get('hour')) || 1;

  if (!course_id) return res.status(400).json({ error: 'course_id requerido' });

  // Verify teacher has access to this course
  // Use limit(1) instead of .single() because a teacher may teach multiple
  // subjects in the same course → multiple rows in raice_teacher_courses
  if (user.role === 'teacher') {
    const { data: accessRows } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!accessRows || !accessRows.length) {
      return res.status(403).json({ error: 'No tienes acceso a este curso' });
    }
  }

  // Determinar si es subgrupo para cargar estudiantes correctamente
  const { data: courseTypeRow } = await sb.from('raice_courses')
    .select('type').eq('id', course_id).maybeSingle();

  let students;
  if (courseTypeRow?.type === 'subgroup') {
    const { data: memberRows } = await sb.from('raice_subgroup_members')
      .select('raice_students(id, first_name, last_name, status)')
      .eq('subgroup_course_id', course_id);
    students = (memberRows || [])
      .map(m => m.raice_students)
      .filter(s => s && s.status === 'active')
      .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));
  } else {
    const { data: studentsData } = await sb.from('raice_students')
      .select('id, first_name, last_name').eq('course_id', course_id).eq('status', 'active')
      .order('last_name');
    students = studentsData || [];
  }

  // Get existing attendance for this date and hour
  const { data: attendance } = await sb.from('raice_attendance')
    .select('student_id, status, activity_note, teacher_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour);

  const attMap = {};
  (attendance || []).forEach(a => attMap[a.student_id] = a.status);
  const savedBy = (attendance && attendance.length > 0) ? (attendance[0].teacher_id || null) : null;

  // Check active suspensions for students in this course
  const studentIds = (students || []).map(s => s.id);
  let suspMap = {};
  if (studentIds.length) {
    const today = todayCO();
    const { data: suspRows } = await sb.from('raice_suspensions')
      .select('student_id, start_date, end_date, reason')
      .in('student_id', studentIds)
      .lte('start_date', today).gte('end_date', today);
    (suspRows || []).forEach(s => { suspMap[s.student_id] = s; });
  }

  // Fetch excusas for PE students on this date
  const peStudentIds = (students || [])
    .filter(s => !suspMap[s.id] && attMap[s.id] === 'PE')
    .map(s => s.id);

  let excusaMap = {};
  let excusaQueryOk = true;
  if (peStudentIds.length) {
    const { data: excusas, error: excusaErr } = await sb.from('raice_excusas')
      .select('student_id, motivo, horas, registered_by, raice_users(first_name, last_name)')
      .in('student_id', peStudentIds)
      .eq('date', date);
    if (excusaErr) {
      excusaQueryOk = false;
    } else {
      (excusas || []).forEach(e => { excusaMap[e.student_id] = e; });
    }
  }

  const studentsWithAtt = (students || []).map(s => ({
    ...s,
    // Suspended students → 'A'. Otherwise use saved status (PE manual is valid).
    attendance_status: suspMap[s.id] ? 'A' : (attMap[s.id] || 'P'),
    suspension: suspMap[s.id] || null,
    // Excusa info for PE students (tooltip)
    excusa: excusaMap[s.id] || null
  }));

  const activityNote = (attendance || []).find(a => a.activity_note)?.activity_note || null;
  
  // A list is considered "saved" only if EVERY active student has a record for this hour
  const isSaved = students && students.length > 0 && (attendance || []).length >= students.length;

  return res.status(200).json({
    students: studentsWithAtt,
    saved: isSaved,
    saved_by: savedBy,
    hour,
    activity_note: activityNote
  });
}

async function getAttendanceRange(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher', 'rector');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const from      = url.searchParams.get('from');
  const to        = url.searchParams.get('to');
  const hour      = url.searchParams.get('hour'); // optional
  const tc_id     = url.searchParams.get('tc_id'); // teacher_course_id for schedule-based filtering

  if (!course_id || !from || !to)
    return res.status(400).json({ error: 'course_id, from y to son requeridos' });

  // Verify teacher access
  if (user.role === 'teacher') {
    const { data: access } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!access?.length) return res.status(403).json({ error: 'No tienes acceso a este curso' });
  }

  // Students in course
  const { data: students } = await sb.from('raice_students')
    .select('id, first_name, last_name').eq('course_id', course_id).eq('status','active')
    .order('last_name');

  // Attendance records in range
  let q = sb.from('raice_attendance')
    .select('student_id, date, class_hour, status')
    .eq('course_id', course_id)
    .gte('date', from).lte('date', to)
    .order('date').order('class_hour');
  if (hour) q = q.eq('class_hour', parseInt(hour));
  const { data: allRecords } = await q;

  // If teacher provides tc_id, filter records to only their scheduled hours
  let records = allRecords || [];
  if (tc_id && user.role === 'teacher') {
    const { data: schedRows } = await sb.from('raice_schedules')
      .select('day_of_week, class_hour')
      .eq('teacher_course_id', tc_id);
    if (schedRows && schedRows.length) {
      const schedSet = new Set(schedRows.map(s => `${s.day_of_week}-${s.class_hour}`));
      records = records.filter(r => {
        const dow = dayOfWeekCO(r.date);
        return schedSet.has(`${dow}-${r.class_hour}`);
      });
    }
  }

  // Unique sorted dates that have at least one record
  const datesSet = new Set(records.map(r => r.date));
  const dates = [...datesSet].sort();

  return res.status(200).json({
    students: students || [],
    dates,
    records
  });
}


// =====================================================

async function handleCases(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam === 'all' ? 10000 : Math.min(10000, Math.max(1, parseInt(limitParam || '10000')));
    const offset = (page - 1) * limit;

    let query = sb.from('raice_cases')
      .select('id, student_name, grade, course, type, description, actions_taken, status, created_at, teacher_id', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (user.role === 'teacher') query = query.eq('teacher_id', user.id);
    // Filtrar por sedes para coordinadores — siempre leemos desde la BD, con sede_filter opcional
    if (user.role === 'admin') {
      const caseSedeFilter = url.searchParams.get('sede_filter');
      const adminSedeIds = await getAdminSedeIds(sb, user, caseSedeFilter);
      if (adminSedeIds && adminSedeIds.length > 0) {
        const { data: scs } = await sb.from('raice_courses')
          .select('id').in('sede_id', adminSedeIds).neq('type','subgroup');
        const cIds = (scs||[]).map(c=>c.id);
        query = query.in('course_id', cIds.length ? cIds : ['00000000-0000-0000-0000-000000000000']);
      } else {
        query = query.in('course_id', ['00000000-0000-0000-0000-000000000000']);
      }
    }

    const filter = url.searchParams.get('type');
    if (filter) query = query.eq('type', parseInt(filter));

    const { data, error, count } = await query;

    // If join fails try without join
    if (error) return res.status(500).json({ error: _dbErr(error, '') });

    // Get teacher names separately to avoid FK name issues
    const teacherIds = [...new Set((data||[]).map(c => c.teacher_id).filter(Boolean))];
    const teacherMap = {};
    if (teacherIds.length > 0) {
      const { data: teachers } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', teacherIds);
      (teachers||[]).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
    }

    const cases = (data || []).map(c => ({
      ...c, teacher_name: teacherMap[c.teacher_id] || '—'
    }));

    return res.status(200).json({ cases, total: count || 0, page, limit });
  }

  if (req.method === 'POST') {
    const { student_id, course_id, type, description, actions_taken, notes, falta_id, falta_numeral, falta_descripcion, falta_categoria, otros_involucrados } = req.body || {};
    if (!student_id || !type || !description) return res.status(400).json({ error: 'Datos incompletos' });

    // Get student info for denormalization
    const { data: student } = await sb.from('raice_students')
      .select('first_name, last_name, grade, course').eq('id', student_id).single();

    const { data: caseData, error } = await sb.from('raice_cases').insert({
      student_id, course_id,
      student_name: student ? `${student.first_name} ${student.last_name}` : 'Desconocido',
      grade: student?.grade, course: student?.course,
      teacher_id: user.id, type, description, actions_taken, notes,
      falta_id: falta_id || null,
      falta_numeral: falta_numeral || null,
      falta_descripcion: falta_descripcion || null,
      falta_categoria: falta_categoria || null,
      otros_involucrados: otros_involucrados || null,
      status: 'open'
    }).select().single();

    if (error) return res.status(500).json({ error: 'Error al registrar caso', detail: error.message || error.details || '' });

    // Para Tipo I: notificación informativa al coordinador (no requiere acción)
    // Para Tipo II y III: notificación de acción requerida
    const notifTitle = type === 1
      ? `[Informativo] Caso Tipo I — ${student?.first_name} ${student?.last_name}`
      : `Nuevo caso Tipo ${type} — ${student?.first_name} ${student?.last_name}`;
    const notifBody = type === 1
      ? `Docente ${user.username} inició seguimiento · ${student?.grade}°${student?.course}${falta_numeral ? ` · Falta ${falta_numeral}` : ''}`
      : `Reportado por ${user.username} · ${student?.grade}°${student?.course}`;

    const { data: admins } = await sb.from('raice_users').select('id').eq('role', 'admin').eq('active', true);
    for (const admin of (admins || [])) {
      await sendNotification(sb, admin.id, user.id, type === 1 ? 'info_tipo1' : 'new_case',
        notifTitle, notifBody, caseData.id);
    }

    await logActivity(sb, user.id, 'create_case', `Caso Tipo ${type} registrado para ${student?.first_name} ${student?.last_name}${falta_numeral ? ` (Falta ${falta_numeral})` : ''}`);

    return res.status(200).json({ success: true, case: caseData });
  }

  return res.status(405).end();
}

async function getMyCases(req, res, user) {
  const sb = getSupabase();
  const { data, error } = await sb.from('raice_cases')
    .select('id, student_name, grade, course, type, description, actions_taken, status, created_at, falta_id, falta_numeral, falta_descripcion, falta_categoria, otros_involucrados')
    .eq('teacher_id', user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Error al cargar casos' });
  return res.status(200).json({ cases: data || [] });
}

// =====================================================
// OBSERVATIONS
// =====================================================

async function handleObservations(req, res, user) {
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { student_id, type, text, course_id } = req.body || {};
  if (!student_id || !text) return res.status(400).json({ error: 'Datos incompletos' });

  const { error } = await sb.from('raice_observations').insert({
    student_id, teacher_id: user.id, course_id, type: type || 'neutral', text
  });

  if (error) return res.status(500).json({ error: 'Error al guardar observación' });
  return res.status(200).json({ success: true });
}

// =====================================================
// CONFIG
// =====================================================

async function handleConfig(req, res, user) {
  // GET is public to all authenticated users (teachers need logo_url and classes_per_day)
  // POST is restricted to superadmin/admin
  if (req.method === 'POST') requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { school_name, location, dane_code, year, num_periods, periods_config, classes_per_day, logo_url,
            correction_window, correction_window_minutes, correction_window_hour } = req.body || {};
    const updates = {};
    if (school_name    !== undefined) updates.school_name    = school_name;
    if (location       !== undefined) updates.location       = location;
    if (dane_code      !== undefined) updates.dane_code      = dane_code;
    if (year           !== undefined) updates.year           = year;
    if (num_periods    !== undefined) updates.num_periods    = num_periods;
    if (periods_config !== undefined) updates.periods_config = periods_config;
    if (classes_per_day !== undefined) updates.classes_per_day = classes_per_day;
    if (logo_url !== undefined) updates.logo_url = logo_url || null;
    // Correction window settings
    if (correction_window         !== undefined) updates.correction_window         = correction_window;
    if (correction_window_minutes !== undefined) updates.correction_window_minutes = correction_window_minutes;
    if (correction_window_hour    !== undefined) {
      // Ensure the value is stored as TEXT in HH:MM format.
      // The column was mistakenly created as INTEGER in some deployments,
      // so we validate the format here to give a clear error instead of a 500.
      if (correction_window_hour !== null) {
        const hourStr = String(correction_window_hour).trim();
        if (!/^\d{2}:\d{2}$/.test(hourStr)) {
          return res.status(400).json({ error: 'Formato de hora inválido. Use HH:MM (ej: 17:00)' });
        }
        updates.correction_window_hour = hourStr;
      } else {
        updates.correction_window_hour = null;
      }
    }

    // Try update first, then insert if no row exists
    const { data: existing } = await sb.from('raice_config').select('id').eq('id', 1).maybeSingle();
    let error;
    if (existing) {
      ({ error } = await sb.from('raice_config').update(updates).eq('id', 1));
    } else {
      ({ error } = await sb.from('raice_config').insert({ id: 1, ...updates }));
    }
    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'config', `Configuración actualizada`);
    return res.status(200).json({ success: true });
  }

  const { data } = await sb.from('raice_config').select('*').eq('id', 1).maybeSingle();
  const config = data || {};
  // Parse periods_config if it's a JSON string
  if (config.periods_config && typeof config.periods_config === 'string') {
    try { config.periods_config = JSON.parse(config.periods_config); } catch (_) {}
  }
  return res.status(200).json(config);
}

// Expose Supabase public credentials for Realtime subscriptions
async function handleRealtimeConfig(req, res, user) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    // Return 200 with error info to avoid polluting console with 500s
    return res.status(200).json({ ok: false, error: 'Realtime no configurado en variables de entorno' });
  }
  return res.status(200).json({ ok: true, supabase_url: url, supabase_anon_key: key });
}

async function handleSecurityConfig(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { new_password, session_timeout } = req.body || {};

  // Save timeout to config
  const updates = { session_timeout: session_timeout || 60 };
  const { data: existing } = await sb.from('raice_config').select('id').eq('id', 1).maybeSingle();
  if (existing) await sb.from('raice_config').update(updates).eq('id', 1);
  else          await sb.from('raice_config').insert({ id: 1, ...updates });

  // Change password if provided
  if (new_password && new_password.length >= 6) {
    const hash = await bcrypt.hash(new_password, 10);
    const { error } = await sb.from('raice_users').update({ password_hash: hash }).eq('id', user.id);
    if (error) return res.status(500).json({ error: 'Error al cambiar contraseña' });
    await logActivity(sb, user.id, 'config', 'Contraseña de superadmin actualizada');
  }

  await logActivity(sb, user.id, 'config', `Seguridad actualizada — timeout: ${session_timeout}min`);
  return res.status(200).json({ success: true });
}

// =====================================================
// LOGS
// =====================================================

async function handleLogs(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type  = url.searchParams.get('type')  || '';
  const limit = parseInt(url.searchParams.get('limit')) || 100;

  let query = sb.from('raice_logs')
    .select('id, event_type, detail, created_at, raice_users(first_name, last_name, username)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (type) query = query.eq('event_type', type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: _dbErr(error, '') });

  const logs = (data || []).map(l => ({
    id:         l.id,
    event_type: l.event_type,
    detail:     l.detail,
    created_at: l.created_at,
    user_name:  l.raice_users ? `${l.raice_users.first_name} ${l.raice_users.last_name}` : 'Sistema',
    username:   l.raice_users?.username || '—'
  }));

  return res.status(200).json({ logs });
}

async function changePassword(req, res, user) {
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Campos requeridos' });
  if (new_password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const { data: u } = await sb.from('raice_users').select('password_hash').eq('id', user.id).single();
  const valid = await bcrypt.compare(current_password, u?.password_hash || '');
  if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  const password_hash = await bcrypt.hash(new_password, 10);
  const { error } = await sb.from('raice_users').update({ password_hash }).eq('id', user.id);
  if (error) return res.status(500).json({ error: 'Error al actualizar contraseña' });

  await logActivity(sb, user.id, 'change_password', 'Contraseña actualizada por el usuario');
  return res.status(200).json({ success: true });
}
// =====================================================
// FASE 2 — NUEVOS ENDPOINTS
// =====================================================

// ---- CASE DETAIL ----
async function getCaseDetail(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.replace('/api/', '').split('/').filter(Boolean);
  const caseId = parts[2];
  if (!caseId) return res.status(400).json({ error: 'ID requerido' });

  const { data: caseData, error } = await sb.from('raice_cases')
    .select('*').eq('id', caseId).single();
  if (error || !caseData) return res.status(404).json({ error: 'Caso no encontrado' });

  if (user.role === 'teacher' && caseData.teacher_id !== user.id)
    return res.status(403).json({ error: 'No tienes acceso a este caso' });

  // Parallel: teacher, student full info, followups, commitments, acudientes
  const [
    teacherRes, studentRes, followupsRaw, commitmentsRes, acudRes, configRes
  ] = await Promise.all([
    caseData.teacher_id
      ? sb.from('raice_users').select('first_name, last_name, email').eq('id', caseData.teacher_id).single()
      : Promise.resolve({ data: null }),
    caseData.student_id
      ? sb.from('raice_students').select('first_name, last_name, grade, course, doc_type, doc_number, birth_date').eq('id', caseData.student_id).single()
      : Promise.resolve({ data: null }),
    sb.from('raice_followups').select('*').eq('case_id', caseId).order('created_at'),
    sb.from('raice_commitments').select('*').eq('case_id', caseId).order('created_at'),
    caseData.student_id
      ? sb.from('raice_acudientes').select('name, phone, email, relationship').eq('student_id', caseData.student_id)
      : Promise.resolve({ data: [] }),
    sb.from('raice_config').select('school_name, location, dane_code, logo_url').eq('id', 1).single()
  ]);

  const teacher  = teacherRes.data;
  const student  = studentRes.data;
  const acudientes = acudRes.data || [];
  const config   = configRes.data || {};

  // Enrich followup coordinator names
  const fUserIds = [...new Set((followupsRaw.data||[]).map(f => f.coordinator_id).filter(Boolean))];
  const fUserMap = {};
  if (fUserIds.length) {
    const { data: fUsers } = await sb.from('raice_users').select('id,first_name,last_name').in('id', fUserIds);
    (fUsers||[]).forEach(u => fUserMap[u.id] = `${u.first_name} ${u.last_name}`);
  }
  const followups = (followupsRaw.data||[]).map(f => ({
    ...f, coordinator_name: fUserMap[f.coordinator_id] || '—'
  }));

  // Generate case number: RAICE-YYYY-NNN (use short id)
  const caseNumber = `RAICE-${new Date(caseData.created_at).getFullYear()}-${caseId.slice(-5).toUpperCase()}`;

  return res.status(200).json({
    case: {
      ...caseData,
      teacher_name: teacher ? `${teacher.first_name} ${teacher.last_name}` : '—',
      teacher_email: teacher?.email || '',
      student_doc_type: student?.doc_type || '',
      student_doc_number: student?.doc_number || '',
      student_birth_date: student?.birth_date || '',
      case_number: caseNumber
    },
    followups,
    commitments: commitmentsRes.data || [],
    acudientes,
    school: config
  });
}

// ---- CASES REPORT (period range) ----
async function getCasesReport(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const from = url.searchParams.get('from') || todayCO(-30);
  const to   = url.searchParams.get('to')   || todayCO();

  const [casesRes, configRes] = await Promise.all([
    sb.from('raice_cases').select('*')
      .gte('created_at', from + 'T00:00:00').lte('created_at', to + 'T23:59:59')
      .order('created_at', { ascending: false }),
    sb.from('raice_config').select('school_name, location, dane_code, logo_url').eq('id', 1).single()
  ]);

  const cases = casesRes.data || [];
  const config = configRes.data || {};

  // Enrich teacher names
  const teacherIds = [...new Set(cases.map(c => c.teacher_id).filter(Boolean))];
  const teacherMap = {};
  if (teacherIds.length) {
    const { data: teachers } = await sb.from('raice_users')
      .select('id, first_name, last_name').in('id', teacherIds);
    (teachers||[]).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
  }

  const enriched = cases.map(c => ({
    ...c,
    teacher_name: teacherMap[c.teacher_id] || '—',
    case_number: `RAICE-${new Date(c.created_at).getFullYear()}-${c.id.slice(-5).toUpperCase()}`
  }));

  return res.status(200).json({ cases: enriched, from, to, school: config });
}


async function updateCaseStatus(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'PUT') return res.status(405).end();
  const sb = getSupabase();
  const { id, status, type } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID requerido' });
  if (!status && !type) return res.status(400).json({ error: 'Se requiere status o type' });
  const updates = {};
  if (status) {
    updates.status = status;
    if (status === 'closed') { updates.closed_at = new Date().toISOString(); updates.closed_by = user.id; }
  }
  if (type && [1, 2, 3].includes(parseInt(type))) {
    updates.type = parseInt(type);
  }
  const { error } = await sb.from('raice_cases').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: 'Error al actualizar caso' });
  const logDetail = [
    status ? `estado → ${status}` : null,
    type   ? `tipo → ${type}`     : null
  ].filter(Boolean).join(', ');
  await logActivity(sb, user.id, 'update_case_status', `Caso ${id}: ${logDetail}`);
  return res.status(200).json({ success: true });
}

// ---- CASE FOLLOWUP ----
async function saveCaseFollowup(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { case_id, actions, status, commitment, signed_by, due_date, descargos, descargo_estudiante } = req.body || {};
  if (!case_id || !actions) return res.status(400).json({ error: 'Datos incompletos' });

  // Save followup record
  const { error: fuError } = await sb.from('raice_followups').insert({
    case_id, coordinator_id: user.id, actions, status: status || 'tracking',
    descargos: descargos || null,
    descargo_estudiante: descargo_estudiante || null,
  });
  if (fuError) return res.status(500).json({ error: 'Error al guardar seguimiento' });

  // Update case status
  const updates = { status: status || 'tracking' };
  if (status === 'closed') { updates.closed_at = new Date().toISOString(); updates.closed_by = user.id; }
  await sb.from('raice_cases').update(updates).eq('id', case_id);

  // Save commitment if provided
  if (commitment) {
    // Get student from case
    const { data: caseRow } = await sb.from('raice_cases').select('student_id').eq('id', case_id).single();
    await sb.from('raice_commitments').insert({
      case_id, student_id: caseRow?.student_id,
      description: commitment, signed_by: signed_by || '',
      due_date: due_date || todayCO(14)
    });
  }

  await logActivity(sb, user.id, 'case_followup', `Seguimiento agregado al caso ${case_id}`);
  return res.status(200).json({ success: true });
}

// ---- COMMITMENTS ----
async function handleCommitments(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();
  if (req.method === 'GET') {
    const { data, error } = await sb.from('raice_commitments')
      .select('*, raice_students(first_name, last_name, grade, course)')
      .order('due_date');
    if (error) return res.status(500).json({ error: 'Error al cargar compromisos' });
    const commitments = (data || []).map(c => ({
      ...c,
      student_name: c.raice_students ? `${c.raice_students.first_name} ${c.raice_students.last_name}` : '—',
      grade: c.raice_students?.grade,
      course: c.raice_students?.course
    }));
    return res.status(200).json({ commitments });
  }
  return res.status(405).end();
}

async function fulfillCommitment(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'PUT') return res.status(405).end();
  const sb = getSupabase();
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'ID requerido' });
  const { error } = await sb.from('raice_commitments')
    .update({ fulfilled: true, fulfilled_at: new Date().toISOString() }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Error al actualizar compromiso' });
  return res.status(200).json({ success: true });
}

// ---- STUDENT HISTORY ----
async function getStudentHistory(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.replace('/api/', '').split('/').filter(Boolean);
  const studentId = parts[2]; // ['raice','student-history','UUID']
  if (!studentId) return res.status(400).json({ error: 'ID requerido' });

  // Teachers can only view history of students in their courses
  if (user.role === 'teacher') {
    const { data: studentRow } = await sb.from('raice_students').select('course_id').eq('id', studentId).single();
    if (!studentRow) return res.status(404).json({ error: 'Estudiante no encontrado' });
    const { data: access } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', studentRow.course_id).limit(1);
    if (!access || !access.length) return res.status(403).json({ error: 'No tienes acceso a este estudiante' });
  }

  const [obsRes, casesRes, attRes, gradeHistRes] = await Promise.all([
    sb.from('raice_observations')
      .select('*, raice_users(first_name, last_name)')
      .eq('student_id', studentId).order('created_at', { ascending: false }),
    sb.from('raice_cases')
      .select('id, type, description, status, created_at')
      .eq('student_id', studentId).order('created_at', { ascending: false }),
    sb.from('raice_attendance')
      .select('status').eq('student_id', studentId),
    sb.from('raice_student_grade_history')
      .select('*, raice_users(first_name, last_name)')
      .eq('student_id', studentId).order('changed_at', { ascending: false }),
  ]);

  const obs = (obsRes.data || []).map(o => ({
    ...o, teacher_name: o.raice_users ? `${o.raice_users.first_name} ${o.raice_users.last_name}` : '—'
  }));

  const att = attRes.data || [];
  const present = att.filter(a => a.status === 'P' || a.status === 'PE').length;
  const attPct = att.length > 0 ? Math.round((present / att.length) * 100) : null;

  const gradeHistory = (gradeHistRes.data || []).map(h => ({
    ...h,
    changed_by_name: h.raice_users ? `${h.raice_users.first_name} ${h.raice_users.last_name}` : '—',
  }));

  return res.status(200).json({
    observations: obs,
    cases: casesRes.data || [],
    att_pct: attPct,
    grade_history: gradeHistory,
  });
}

// ---- STUDENT GRADE HISTORY (endpoint dedicado) ----
async function getStudentGradeHistory(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb = getSupabase();
  const parts = new URL(req.url, `http://${req.headers.host}`)
    .pathname.replace('/api/', '').split('/').filter(Boolean);
  const studentId = parts[2];
  if (!studentId) return res.status(400).json({ error: 'ID requerido' });

  const { data, error } = await sb.from('raice_student_grade_history')
    .select('*, raice_users(first_name, last_name)')
    .eq('student_id', studentId)
    .order('changed_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Error al obtener historial' });

  const history = (data || []).map(h => ({
    ...h,
    changed_by_name: h.raice_users ? `${h.raice_users.first_name} ${h.raice_users.last_name}` : '—',
  }));

  return res.status(200).json({ history });
}

// ---- DASHBOARD ENHANCED (Fase 2) ----
async function getDashboardV2(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb           = getSupabase();
  const url          = new URL(req.url, `http://${req.headers.host}`);
  const today        = todayCO();
  const threeDaysAgo = todayCO(-3);

  // Safe query helper — a failure never kills the whole dashboard
  const safe = async (fn, fallback) => {
    try { return await fn(); } catch (_) { return fallback; }
  };

  // Sede scope: coordinadores con sedes solo ven sus sedes
  // Siempre leemos desde la BD para evitar tokens JWT desactualizados
  const dashSedeFilter = url.searchParams.get('sede_filter');
  let sedeCourseIds = null; // null = sin restricción
  let adminSedeIds  = null; // para applySedeToUsers (admin)
  let rectorSedeIds = null; // para applySedeToUsers (rector/superadmin)

  if (user.role === 'admin') {
    adminSedeIds = await getAdminSedeIds(sb, user, dashSedeFilter);
    if (adminSedeIds && adminSedeIds.length > 0) {
      const { data: scs } = await sb.from('raice_courses')
        .select('id').in('sede_id', adminSedeIds);
      sedeCourseIds = (scs || []).map(c => c.id);
    } else {
      sedeCourseIds = ['00000000-0000-0000-0000-000000000000'];
    }
  } else if (dashSedeFilter && (user.role === 'rector' || user.role === 'superadmin')) {
    // Rector/superadmin filtra opcionalmente por sede
    rectorSedeIds = [dashSedeFilter];
    sedeCourseIds = await getCourseIdsForSedes(sb, rectorSedeIds);
  }

  const applySedeToStudents = (q) => {
    if (sedeCourseIds) return q.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
    return q;
  };
  const applySedeToAtt = (q) => {
    if (sedeCourseIds) return q.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
    return q;
  };
  const applySedeToUsers = (q) => {
    if (user.role === 'admin' && adminSedeIds && adminSedeIds.length > 0) return q.in('sede_id', adminSedeIds);
    if (rectorSedeIds) return q.in('sede_id', rectorSedeIds);
    return q;
  };

  const [studentsRes, teachersRes, casesRes, attRes, commitmentsRes, recentCasesRes] = await Promise.all([
    safe(() => applySedeToStudents(sb.from('raice_students').select('id', { count:'exact', head:true }).eq('status','active')), { count:0 }),
    safe(() => applySedeToUsers(sb.from('raice_users').select('id', { count:'exact', head:true }).eq('role','teacher').eq('active',true)), { count:0 }),
    safe(() => {
      let q = sb.from('raice_cases').select('id', { count:'exact', head:true }).eq('status','open');
      if (sedeCourseIds) q = q.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
      return q;
    }, { count:0 }),
    safe(() => applySedeToAtt(sb.from('raice_attendance').select('status, course_id, class_hour, student_id, raice_courses(grade,number,name,type)').eq('date', today)), { data:[] }),
    // compromisos: no tienen course_id, se muestran globales (métrica secundaria)
    safe(() => sb.from('raice_commitments').select('id', { count:'exact', head:true })
      .eq('fulfilled', false).lt('due_date', todayCO(3)), { count:0 }),
    safe(() => {
      let q = sb.from('raice_cases')
        .select('id, student_id, student_name, grade, course, type, description, status, created_at, teacher_id')
        .order('created_at', { ascending:false }).limit(8);
      if (sedeCourseIds) q = q.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
      return q;
    }, { data:[] })
  ]);

  // Attendance today — filter out PE records from course+hour where no real list was taken
  const attDataRaw = attRes.data || [];
  // Identify course+hour combos where a teacher actually took attendance (P, A, T, S)
  const realListSet = new Set();
  attDataRaw.forEach(a => {
    if (a.status !== 'PE' && a.status !== 'NR') {
      realListSet.add(`${a.course_id}_${a.class_hour}`);
    }
  });
  // Keep PE only if real attendance exists for that course+hour
  const attData = attDataRaw.filter(a => {
    if (a.status === 'PE') return realListSet.has(`${a.course_id}_${a.class_hour}`);
    return true;
  });

  const cntP  = attData.filter(a => a.status === 'P').length;
  const cntT  = attData.filter(a => a.status === 'T').length;
  const cntPE = attData.filter(a => a.status === 'PE').length;
  const cntS  = attData.filter(a => a.status === 'S').length;
  const total = attData.length;
  const countable = total - cntS - cntPE;
  const attPct = countable > 0 ? Math.round(((cntP + cntT) / countable) * 100) : (total - cntS > 0 ? 100 : null);

  // Deduplicated counts for donut chart (per student, keep last hour status)
  const studentDedupMap = {};
  attData.forEach(a => {
    if (!a.student_id) return;
    const key = `${a.student_id}_${a.course_id}`;
    if (!studentDedupMap[key] || (a.class_hour||0) > (studentDedupMap[key].class_hour||0)) studentDedupMap[key] = a;
  });
  const dedupedAtt = Object.values(studentDedupMap);
  const donutPresent = dedupedAtt.filter(a => a.status === 'P').length;
  const donutAbsent  = dedupedAtt.filter(a => a.status === 'A').length;
  const donutLate    = dedupedAtt.filter(a => a.status === 'T').length;
  const donutPermit  = dedupedAtt.filter(a => a.status === 'PE').length;

  // Attendance by grade and course (including subgroups)
  const gradeMap = {};
  attData.forEach(a => {
    const c = a.raice_courses || {};
    let key, grade, isSubgroup = false;
    if (c.type === 'subgroup') {
      key = c.name || 'Subgrupo';
      grade = 9999; // sort subgroups at the end
      isSubgroup = true;
    } else {
      const g = c.grade;
      const n = c.number || '';
      if (!g) return;
      key = n ? `${g}°${n}` : `${g}°`;
      grade = g;
    }
    if (!gradeMap[key]) gradeMap[key] = { grade, present:0, total:0, isSubgroup };
    gradeMap[key].total++;
    if (a.status === 'P' || a.status === 'PE') gradeMap[key].present++;
  });
  const att_by_grade = Object.entries(gradeMap)
    .map(([key, v]) => ({ name: key, grade: v.grade, pct: Math.round((v.present/v.total)*100), isSubgroup: v.isSubgroup }))
    .sort((a,b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      return String(a.name).localeCompare(String(b.name));
    });

  // Alerts — each block independent
  const alerts = [];

  if (sedeCourseIds) {
    // Coordinador de sede: query directa filtrada por course_id (evita mezclar sedes con mismo grado/número)
    try {
      const { data: abRows } = await sb.from('raice_attendance')
        .select('student_id, course_id, date, raice_students(first_name, last_name, grade, course)')
        .eq('status', 'A')
        .gte('date', threeDaysAgo)
        .in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000'])
        .limit(300);
      const countMap = {};
      (abRows || []).forEach(a => {
        if (!countMap[a.student_id]) countMap[a.student_id] = { count: 0, last_date: a.date, stu: a.raice_students };
        countMap[a.student_id].count++;
        if (a.date > countMap[a.student_id].last_date) countMap[a.student_id].last_date = a.date;
      });
      Object.values(countMap).filter(v => v.count >= 2 && v.stu).forEach(v => {
        alerts.push({
          type: 'absence', severity: 'medium',
          title: `${v.stu.first_name} ${v.stu.last_name} — ${v.count} ausencias seguidas`,
          description: `${v.stu.grade}°${v.stu.course || ''} · Última: ${v.last_date}`
        });
      });
    } catch (_) {}
  } else {
    // Superadmin / rector: usa el RPC global
    try {
      const r = await sb.rpc('get_repeated_absences', { since_date: threeDaysAgo });
      (r.data || []).forEach(a => alerts.push({
        type: 'absence', severity: 'medium',
        title: `${a.student_name} — ${a.count} ausencias seguidas`,
        description: `${a.grade}°${a.course} · Última: ${a.last_date}`
      }));
    } catch (_) {}
  }

  try {
    let cq = sb.from('raice_cases')
      .select('id, student_name, type, created_at, course_id')
      .eq('status','open').lt('created_at', threeDaysAgo).limit(5);
    if (sedeCourseIds) cq = cq.in('course_id', sedeCourseIds.length ? sedeCourseIds : ['00000000-0000-0000-0000-000000000000']);
    const r = await cq;
    (r.data || []).forEach(c => alerts.push({
      type:'case', severity: c.type >= 2 ? 'high' : 'medium',
      title:`Caso Tipo ${c.type} sin seguimiento — ${c.student_name}`,
      description:`Abierto hace ${Math.floor((Date.now()-new Date(c.created_at))/86400000)} días`
    }));
  } catch (_) {}

  // ----------------------------------------------------
  // Omisión de Asistencia — una alerta por docente
  // ----------------------------------------------------
  try {
    // 1. Verificamos si hoy es día laborable
    const { data: calDay } = await sb.from('raice_calendar').select('type').eq('date', today);
    const isHoliday = calDay && calDay.some(c => c.type === 'holiday' || c.type === 'vacation' || c.type === 'institutional_day');
    
    if (!isHoliday) {
      // 2. Traer horario y hora actual
      const coDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      const dayOfWeek = coDate.getDay() || 7; // Dom=7
      const currentTimeStr = `${coDate.getHours().toString().padStart(2, '0')}:${coDate.getMinutes().toString().padStart(2, '0')}:00`;

      // 3. Consultar clases programadas para HOY
      const { data: scheds } = await sb.from('raice_schedules')
        .select(`
          class_hour,
          start_time,
          raice_teacher_courses (
            teacher_id,
            course_id,
            subject,
            raice_users ( first_name, last_name ),
            raice_courses ( grade, number, type, name )
          )
        `)
        .eq('day_of_week', dayOfWeek);

      // Traer el horario de timbres en caso de que start_time sea null en schedule
      const { data: bells } = await sb.from('raice_bell_schedule').select('class_hour, start_time');
      const bellMap = {};
      (bells || []).forEach(b => bellMap[b.class_hour] = b.start_time);

      if (scheds && scheds.length > 0) {
        // Filtrar solo las clases cuya hora de inicio ya es menor a la actual
        let pastScheds = scheds.filter(s => {
           const st = s.start_time || bellMap[s.class_hour];
           return st && st < currentTimeStr;
        });

        // Filtrar por sede si es coordinador
        if (sedeCourseIds) {
          const sedeSet = new Set(sedeCourseIds);
          pastScheds = pastScheds.filter(s => s.raice_teacher_courses?.course_id && sedeSet.has(s.raice_teacher_courses.course_id));
        }

        // Armar Set de las asistencias ya tomadas HOY
        // Excluir PE (excusas) y NR — solo P, A, T, S significan que el docente tomó lista
        const takenSet = new Set();
        attData.forEach(a => {
          if (a.course_id && a.class_hour && a.status !== 'PE' && a.status !== 'NR') {
             takenSet.add(`${a.course_id}_${a.class_hour}`);
          }
        });

        // Agrupar omisiones por docente
        const byTeacher = {};
        pastScheds.forEach(s => {
          const tc = s.raice_teacher_courses;
          if (!tc || !tc.course_id || !tc.raice_users || !tc.raice_courses) return;
          if (!takenSet.has(`${tc.course_id}_${s.class_hour}`)) {
            const teacherName = `${tc.raice_users.first_name} ${tc.raice_users.last_name}`;
            if (!byTeacher[teacherName]) byTeacher[teacherName] = [];
            byTeacher[teacherName].push({
              course: `${tc.raice_courses.grade}°${tc.raice_courses.number}`,
              subject: tc.subject || '',
              hour: s.class_hour
            });
          }
        });

        // Una alerta por docente — legible y compacta
        Object.entries(byTeacher).forEach(([teacher, sessions]) => {
          const details = sessions.map(s => `H${s.hour} ${s.course}${s.subject ? ' · '+s.subject : ''}`).join(' — ');
          alerts.unshift({
            type: 'attendance_omission', severity: 'high',
            ico: '🚨',
            title: `${teacher} — sin llamar lista`,
            description: details
          });
        });
      }
    }
  } catch (err) {
    console.error("Omisiones", err);
  }


  if ((commitmentsRes.count || 0) > 0) {
    alerts.push({
      type:'commitment', severity:'medium',
      title:`${commitmentsRes.count} compromisos por vencer pronto`,
      description:'Revisa la sección de compromisos'
    });
  }

  // Resolve teacher names for recent cases
  const recentTeacherIds = [...new Set((recentCasesRes.data || []).map(c => c.teacher_id).filter(Boolean))];
  const recentTeacherMap = {};
  if (recentTeacherIds.length) {
    const { data: tRows } = await sb.from('raice_users')
      .select('id, first_name, last_name').in('id', recentTeacherIds);
    (tRows || []).forEach(t => recentTeacherMap[t.id] = `${t.first_name} ${t.last_name}`);
  }
  const recentCases = (recentCasesRes.data || []).map(c => ({
    ...c, teacher_name: recentTeacherMap[c.teacher_id] || '—'
  }));

  return res.status(200).json({
    students:         studentsRes.count  || 0,
    teachers:         teachersRes.count  || 0,
    open_cases:       casesRes.count     || 0,
    attendance_today: attPct,
    present: donutPresent,
    absent: donutAbsent,
    late: donutLate,
    permit: donutPermit,
    commitments_due:  commitmentsRes.count || 0,
    att_by_grade,
    alerts,
    recent_cases: recentCases
  });
}


// =====================================================
// RECTOR INSIGHTS — Tendencias, cumplimiento, riesgo
// =====================================================
async function getRectorInsights(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const today = todayCO();
  const safe = async (fn, fb) => { try { return await fn(); } catch (_) { return fb; } };

  // Sede filter — works for rector/superadmin (optional) and admin (required)
  const sedeFilter = url.searchParams.get('sede_filter');
  let sedeCourseIds = null;
  if (user.role === 'admin') {
    const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilter);
    sedeCourseIds = await getCourseIdsForSedes(sb, adminSedeIds);
  } else if (sedeFilter) {
    sedeCourseIds = await getCourseIdsForSedes(sb, [sedeFilter]);
  }
  // Helper to apply sede filter to attendance queries
  const applySedeAtt = (q) => sedeCourseIds ? q.in('course_id', sedeCourseIds) : q;
  const applySedeStudents = (q) => sedeCourseIds ? q.in('course_id', sedeCourseIds) : q;

  // ── 1. Tendencia asistencia últimos 30 días ──
  const thirtyAgo = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  const attTrendRaw = await safe(() =>
    applySedeAtt(sb.from('raice_attendance').select('date, status, course_id').gte('date', thirtyAgo).lte('date', today)), { data: [] });
  const trendMap = {};
  (attTrendRaw.data || []).forEach(a => {
    if (a.status === 'NR') return;
    if (!trendMap[a.date]) trendMap[a.date] = { P: 0, A: 0, T: 0, PE: 0, S: 0 };
    if (trendMap[a.date][a.status] !== undefined) trendMap[a.date][a.status]++;
  });
  const attendance_trend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, c]) => {
      const countable = c.P + c.A + c.T;
      const pct = countable > 0 ? Math.round(((c.P + c.T) / countable) * 100) : null;
      return { date, pct, P: c.P, A: c.A, T: c.T, PE: c.PE };
    });

  // ── 2. Ranking grados mes actual ──
  const monthStart = today.substring(0, 8) + '01';
  const attMonthRaw = await safe(() =>
    applySedeAtt(sb.from('raice_attendance').select('status, course_id, raice_courses(grade, number)').gte('date', monthStart).lte('date', today)), { data: [] });
  const gradeMonthMap = {};
  (attMonthRaw.data || []).forEach(a => {
    if (a.status === 'NR' || a.status === 'S') return;
    const g = a.raice_courses?.grade;
    const n = a.raice_courses?.number || '';
    if (!g) return;
    const key = n ? `${g}°${n}` : `${g}°`;
    if (!gradeMonthMap[key]) gradeMonthMap[key] = { grade: g, P: 0, A: 0, T: 0, PE: 0 };
    if (gradeMonthMap[key][a.status] !== undefined) gradeMonthMap[key][a.status]++;
  });
  const grade_ranking = Object.entries(gradeMonthMap)
    .map(([name, c]) => {
      const countable = c.P + c.A + c.T;
      const pct = countable > 0 ? Math.round(((c.P + c.T) / countable) * 100) : null;
      return { name, grade: c.grade, pct, total: countable };
    })
    .filter(g => g.pct !== null)
    .sort((a, b) => b.pct - a.pct);

  // ── 3. Cumplimiento docente hoy ──
  const dayOfWeek = dayOfWeekCO(today);
  const schedsRes = await safe(() =>
    sb.from('raice_schedules').select('class_hour, start_time, raice_teacher_courses(teacher_id, course_id, subject, raice_users(first_name, last_name), raice_courses(grade, number))').eq('day_of_week', dayOfWeek), { data: [] });
  const bellsRes = await safe(() => sb.from('raice_bell_schedule').select('class_hour, start_time'), { data: [] });
  const bellMap = {};
  (bellsRes.data || []).forEach(b => bellMap[b.class_hour] = b.start_time);

  const coDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const currentTime = `${coDate.getHours().toString().padStart(2, '0')}:${coDate.getMinutes().toString().padStart(2, '0')}:00`;

  // Attendance taken today
  const todayAttRes = await safe(() =>
    applySedeAtt(sb.from('raice_attendance').select('course_id, class_hour, status').eq('date', today)), { data: [] });
  const takenSet = new Set();
  (todayAttRes.data || []).forEach(a => {
    if (a.status !== 'PE' && a.status !== 'NR') takenSet.add(`${a.course_id}_${a.class_hour}`);
  });

  // Build teacher compliance
  const sedeSet = sedeCourseIds ? new Set(sedeCourseIds) : null;
  const teacherStats = {};
  (schedsRes.data || []).forEach(s => {
    const tc = s.raice_teacher_courses;
    if (!tc || !tc.raice_users || !tc.course_id) return;
    if (sedeSet && !sedeSet.has(tc.course_id)) return; // filter by sede
    const st = s.start_time || bellMap[s.class_hour];
    if (!st || st >= currentTime) return; // only past hours
    const tid = tc.teacher_id;
    const name = `${tc.raice_users.first_name} ${tc.raice_users.last_name}`;
    if (!teacherStats[tid]) teacherStats[tid] = { name, scheduled: 0, taken: 0 };
    teacherStats[tid].scheduled++;
    if (takenSet.has(`${tc.course_id}_${s.class_hour}`)) teacherStats[tid].taken++;
  });
  const teacher_compliance = Object.values(teacherStats)
    .map(t => ({ ...t, pct: t.scheduled > 0 ? Math.round((t.taken / t.scheduled) * 100) : null }))
    .sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));

  // ── 4. Resumen de casos por tipo ──
  const casesAllRes = await safe(() => {
    let q = sb.from('raice_cases').select('type, status, created_at, course_id');
    if (sedeCourseIds) q = q.in('course_id', sedeCourseIds);
    return q;
  }, { data: [] });
  const casesAll = casesAllRes.data || [];
  const cases_summary = { total: casesAll.length, open: 0, closed: 0, by_type: { 1: 0, 2: 0, 3: 0 }, this_month: 0 };
  casesAll.forEach(c => {
    if (c.status === 'open' || c.status === 'tracking') cases_summary.open++;
    else cases_summary.closed++;
    if (cases_summary.by_type[c.type] !== undefined) cases_summary.by_type[c.type]++;
    if (c.created_at && c.created_at.slice(0, 10) >= monthStart) cases_summary.this_month++;
  });

  // ── 5. Estudiantes en riesgo ──
  // Low attendance + open cases + unfulfilled commitments
  const [riskAttRes, riskCasesRes, riskCommRes, riskStudentsRes] = await Promise.all([
    safe(() => applySedeAtt(sb.from('raice_attendance').select('student_id, status, course_id').gte('date', monthStart)), { data: [] }),
    safe(() => { let q = sb.from('raice_cases').select('student_id, course_id').in('status', ['open', 'tracking']); if (sedeCourseIds) q = q.in('course_id', sedeCourseIds); return q; }, { data: [] }),
    safe(() => sb.from('raice_commitments').select('student_id').eq('fulfilled', false), { data: [] }),
    safe(() => applySedeStudents(sb.from('raice_students').select('id, first_name, last_name, grade, course_id, raice_courses(grade, number)').eq('status', 'active')), { data: [] })
  ]);

  // Build attendance % per student
  const stuAttMap = {};
  (riskAttRes.data || []).forEach(a => {
    if (a.status === 'NR' || a.status === 'S') return;
    if (!stuAttMap[a.student_id]) stuAttMap[a.student_id] = { countable: 0, present: 0 };
    if (a.status !== 'PE') stuAttMap[a.student_id].countable++;
    if (a.status === 'P' || a.status === 'T') stuAttMap[a.student_id].present++;
  });

  // Build open cases count per student
  const stuCasesMap = {};
  (riskCasesRes.data || []).forEach(c => { stuCasesMap[c.student_id] = (stuCasesMap[c.student_id] || 0) + 1; });

  // Build unfulfilled commitments count per student
  const stuCommMap = {};
  (riskCommRes.data || []).forEach(c => { stuCommMap[c.student_id] = (stuCommMap[c.student_id] || 0) + 1; });

  // Score students
  const studentMap = {};
  (riskStudentsRes.data || []).forEach(s => { studentMap[s.id] = s; });

  const riskScores = Object.keys(studentMap).map(sid => {
    const att = stuAttMap[sid];
    const attPct = att && att.countable > 0 ? Math.round((att.present / att.countable) * 100) : null;
    const openCases = stuCasesMap[sid] || 0;
    const pendingComm = stuCommMap[sid] || 0;
    // Risk score: lower attendance = higher risk, more cases = higher risk
    let score = 0;
    if (attPct !== null && attPct < 80) score += (80 - attPct) * 2;
    if (attPct !== null && attPct < 60) score += 30;
    score += openCases * 20;
    score += pendingComm * 10;
    if (score === 0) return null;
    const s = studentMap[sid];
    const courseLabel = s.raice_courses ? `${s.raice_courses.grade}°${s.raice_courses.number || ''}` : '';
    return { id: sid, name: `${s.first_name} ${s.last_name}`, course: courseLabel, att_pct: attPct, open_cases: openCases, pending_commitments: pendingComm, risk_score: score };
  }).filter(Boolean).sort((a, b) => b.risk_score - a.risk_score).slice(0, 15);

  // ── 6. Resumen de excusas recientes ──
  const weekAgo = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
  const excusasRes = await safe(() => {
    let q = sb.from('raice_excusas').select('id, student_id, course_id, date, motivo, horas, registered_by, created_at, raice_students(first_name, last_name), raice_users(first_name, last_name)').gte('created_at', weekAgo + 'T00:00:00').order('created_at', { ascending: false }).limit(30);
    if (sedeCourseIds) q = q.in('course_id', sedeCourseIds);
    return q;
  }, { data: [] });
  const excusasData = excusasRes.data || [];
  // Classify: if horas array has items → "por horas", else "dia completo"
  // (rango = same student appears on multiple consecutive dates, but simplified here)
  const excusas_summary = {
    total_week: excusasData.length,
    by_type: { dia_completo: 0, horas: 0 },
    recent: excusasData.slice(0, 10).map(e => ({
      date: e.date,
      motivo: e.motivo,
      student_name: e.raice_students ? `${e.raice_students.first_name} ${e.raice_students.last_name}` : '—',
      registered_by_name: e.raice_users ? `${e.raice_users.first_name} ${e.raice_users.last_name}` : '—',
      horas: e.horas
    }))
  };
  excusasData.forEach(e => {
    if (e.horas && e.horas.length > 0) excusas_summary.by_type.horas++;
    else excusas_summary.by_type.dia_completo++;
  });

  return res.status(200).json({
    attendance_trend,
    grade_ranking,
    teacher_compliance,
    cases_summary,
    students_at_risk: riskScores,
    excusas_summary
  });
}


// =====================================================
// FASE 3 — PERÍODOS, NOTIFICACIONES, CITACIONES
// =====================================================

// ---- PERÍODOS ----
async function handlePeriods(req, res, user) {
  const sb = getSupabase();
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const yearParam = url.searchParams.get('year');
    const currentYear = yearParam ? parseInt(yearParam) : new Date().getFullYear();
    // Read num_periods from config to never return more periods than configured
    const { data: cfg } = await sb.from('raice_config').select('num_periods').eq('id', 1).maybeSingle();
    const maxPeriods = cfg?.num_periods || 4;
    const { data } = await sb.from('raice_periods').select('*')
      .eq('year', currentYear)
      .lte('period_num', maxPeriods)
      .order('period_num');
    return res.status(200).json({ periods: data || [] });
  }
  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { name, start_date, end_date, year, period_num, active } = req.body || {};
    if (!name || !start_date || !end_date) return res.status(400).json({ error: 'Datos incompletos' });
    if (active) await sb.from('raice_periods').update({ active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await sb.from('raice_periods').insert({ name, start_date, end_date, year: parseInt(year), period_num: parseInt(period_num), active: !!active }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, period: data });
  }
  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, name, start_date, end_date, year, period_num, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (name       !== undefined) updates.name       = name;
    if (start_date !== undefined) updates.start_date = start_date;
    if (end_date   !== undefined) updates.end_date   = end_date;
    if (year       !== undefined) updates.year       = parseInt(year);
    if (period_num !== undefined) updates.period_num = parseInt(period_num);
    if (active     !== undefined) {
      updates.active = !!active;
      if (active) await sb.from('raice_periods').update({ active: false }).neq('id', id);
    }
    const { error } = await sb.from('raice_periods').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
}

// ---- SYNC PERIODS ----
async function syncPeriods(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { year, periods } = req.body || {};
  if (!year || !Array.isArray(periods)) return res.status(400).json({ error: 'Datos incompletos' });

  const toInsert = periods
    .map((p, i) => ({
      name:       p.name || (i+1) + '° Período',
      year:       parseInt(year),
      period_num: i + 1,
      start_date: p.start || null,
      end_date:   p.end   || null,
      active:     i === 0
    }))
    .filter(p => p.start_date && p.end_date);

  // Safety check: never delete existing data if there's nothing valid to insert
  if (toInsert.length === 0) {
    return res.status(400).json({ error: 'Ningún período tiene fechas válidas de inicio y fin. No se realizaron cambios.' });
  }

  // Delete all periods for this year then recreate
  await sb.from('raice_periods').delete().eq('year', parseInt(year));

  const { error } = await sb.from('raice_periods').insert(toInsert);
  if (error) return res.status(500).json({ error: _dbErr(error) });

  await logActivity(sb, user.id, 'sync_periods', `${toInsert.length} períodos sincronizados para ${year}`);
  return res.status(200).json({ success: true, synced: toInsert.length });
}

// ---- NOTIFICACIONES ----
async function handleNotifications(req, res, user) {
  const sb = getSupabase();
  if (req.method === 'GET') {
    try {
      const { data, error } = await sb.from('raice_notifications')
        .select(`
          *,
          raice_users!raice_notifications_from_user_id_fkey (
            first_name,
            last_name
          )
        `)
        .eq('to_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const unread = (data || []).filter(n => !n.read).length;
      return res.status(200).json({ notifications: data || [], unread });
    } catch (err) {
      console.error('[RAICE API] Notifications Error:', err.message);
      // Fallback: try without join if the above failed (maybe relationship issues)
      const { data: simpleData } = await sb.from('raice_notifications')
        .select('*')
        .eq('to_user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      return res.status(200).json({ notifications: simpleData || [], unread: 0, error: 'Partial load' });
    }
  }
  if (req.method === 'PUT') {
    const { id } = req.body || {};
    if (id === 'all') {
      await sb.from('raice_notifications').update({ read: true }).eq('to_user_id', user.id);
    } else {
      await sb.from('raice_notifications').update({ read: true }).eq('id', id).eq('to_user_id', user.id);
    }
    return res.status(200).json({ success: true });
  }
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    if (id === 'read') {
      // Delete all read notifications for this user
      await sb.from('raice_notifications').delete().eq('to_user_id', user.id).eq('read', true);
    } else {
      // Delete single notification (only own)
      await sb.from('raice_notifications').delete().eq('id', id).eq('to_user_id', user.id);
    }
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
}

async function sendNotification(sb, toUserId, fromUserId, type, title, body, linkId = null) {
  const { error } = await sb.from('raice_notifications').insert({
    to_user_id: toUserId, from_user_id: fromUserId, type, title, body, link_id: linkId
  });
  if (error) console.error('[RAICE Notification]', error.message, { toUserId, type });
}

// ---- CITACIONES ----
async function handleCitations(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();
  if (req.method === 'GET') {
    const { data } = await sb.from('raice_citations')
      .select('*, raice_users(first_name, last_name)')
      .order('created_at', { ascending: false });
    return res.status(200).json({ citations: (data || []).map(c => ({ ...c, coordinator_name: c.raice_users ? `${c.raice_users.first_name} ${c.raice_users.last_name}` : '—' })) });
  }
  if (req.method === 'POST') {
    const { student_id, case_id, reason, date_time, place } = req.body || {};
    if (!student_id || !reason) return res.status(400).json({ error: 'Datos incompletos' });
    const { data: student } = await sb.from('raice_students').select('first_name, last_name').eq('id', student_id).single();
    const { data, error } = await sb.from('raice_citations').insert({
      student_id, student_name: student ? `${student.first_name} ${student.last_name}` : 'Desconocido',
      case_id: case_id || null, coordinator_id: user.id, reason, date_time: date_time || null,
      place: place || 'Coordinación de Convivencia'
    }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'create_citation', `Citación creada para ${student?.first_name}`);
    return res.status(200).json({ success: true, citation: data });
  }
  if (req.method === 'PUT') {
    const { id, attended, notes } = req.body || {};
    await sb.from('raice_citations').update({ attended, notes }).eq('id', id);
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
}

// ---- STATS BY PERIOD ----
async function getStatsByPeriod(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const periodId = url.searchParams.get('period_id');

  let startDate, endDate;
  if (periodId) {
    const { data: period } = await sb.from('raice_periods').select('start_date, end_date').eq('id', periodId).single();
    if (period) { startDate = period.start_date; endDate = period.end_date; }
  }
  if (!startDate) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    now.setDate(1); startDate = now.toISOString().split('T')[0];
    endDate = todayCO();
  }

  // Sede scope para coordinadores — siempre leemos desde la BD, con sede_filter opcional
  const statsSedeFilter = url.searchParams.get('sede_filter');
  let statsCourseIds = null;
  if (user.role === 'admin') {
    const adminSedeIds = await getAdminSedeIds(sb, user, statsSedeFilter);
    if (adminSedeIds && adminSedeIds.length > 0) {
      const { data: scs } = await sb.from('raice_courses')
        .select('id').in('sede_id', adminSedeIds).neq('type', 'subgroup');
      statsCourseIds = (scs || []).map(c => c.id);
    } else {
      statsCourseIds = ['00000000-0000-0000-0000-000000000000'];
    }
  }
  const none = ['00000000-0000-0000-0000-000000000000'];

  const [casesRes, attRes, studentsRes] = await Promise.all([
    (() => {
      let q = sb.from('raice_cases').select('type, grade, course, status, created_at').gte('created_at', startDate).lte('created_at', endDate + 'T23:59:59');
      if (statsCourseIds) q = q.in('course_id', statsCourseIds.length ? statsCourseIds : none);
      return q;
    })(),
    (() => {
      let q = sb.from('raice_attendance').select('status, student_id, date, class_hour, course_id').gte('date', startDate).lte('date', endDate);
      if (statsCourseIds) q = q.in('course_id', statsCourseIds.length ? statsCourseIds : none);
      return q;
    })(),
    (() => {
      let q = sb.from('raice_students').select('id, grade, course').eq('status', 'active');
      if (statsCourseIds) q = q.in('course_id', statsCourseIds.length ? statsCourseIds : none);
      return q;
    })(),
  ]);

  const cases = casesRes.data || [];
  const attRaw = attRes.data || [];
  // Deduplicate: use last class_hour per student per day
  const attDedup = {};
  attRaw.forEach(a => {
    const key = a.student_id + '_' + a.date;
    if (!attDedup[key] || (a.class_hour||1) > (attDedup[key].class_hour||1)) attDedup[key] = a;
  });
  const att = Object.values(attDedup);

  // Cases by type
  const byType = { 1:0, 2:0, 3:0 };
  cases.forEach(c => byType[c.type] = (byType[c.type]||0) + 1);

  // Cases by grade+course
  const byGrade = {};
  cases.forEach(c => {
    const key = c.course ? `${c.grade}-${c.course}` : `${c.grade}`;
    byGrade[key] = (byGrade[key]||0) + 1;
  });

  // Attendance overall — only show % if real list was taken (not just PE from excusas)
  const cntP  = att.filter(a => a.status === 'P').length;
  const cntT  = att.filter(a => a.status === 'T').length;
  const cntPE = att.filter(a => a.status === 'PE').length;
  const cntS  = att.filter(a => a.status === 'S').length;
  const totalAtt = att.length;
  const countable = totalAtt - cntS - cntPE;
  const attPct = countable > 0 ? Math.round(((cntP + cntT) / countable) * 100) : (totalAtt - cntS > 0 ? 100 : null);

  // Attendance by grade
  const attByGrade = {};
  // Match grades from students data
  const studentGrades = {};
  (studentsRes.data || []).forEach(s => { if (s.id) studentGrades[s.id] = { grade: s.grade, course: s.course }; });
  att.forEach(a => {
    const st = studentGrades[a.student_id];
    if (!st || !st.grade) return;
    const key = st.course ? `${st.grade}-${st.course}` : `${st.grade}`;
    if (!attByGrade[key]) attByGrade[key] = { grade: st.grade, present:0, total:0, hasReal:false };
    if (a.status !== 'PE') attByGrade[key].hasReal = true;
    attByGrade[key].total++;
    if (a.status === 'P' || a.status === 'PE') attByGrade[key].present++;
  });

  return res.status(200).json({
    period: { start_date: startDate, end_date: endDate },
    cases_total: cases.length,
    cases_open: cases.filter(c => c.status === 'open').length,
    cases_closed: cases.filter(c => c.status === 'closed').length,
    cases_by_type: byType,
    cases_by_grade: Object.entries(byGrade).map(([key,n]) => {
      const [g, c] = key.split('-');
      return { grade: parseInt(g), course: c || null, name: key, count: n };
    }).sort((a,b) => a.grade !== b.grade ? a.grade - b.grade : String(a.course||'').localeCompare(String(b.course||''))),
    attendance_pct: attPct,
    att_by_grade: Object.entries(attByGrade).map(([key,v]) => ({
      name: key,
      grade: v.grade,
      pct: Math.round((v.present/v.total)*100)
    })).sort((a,b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      return String(a.name).localeCompare(String(b.name));
    })
  });
}

// ---- TEACHER-COURSES ASSIGNMENT ----
async function handleTeacherCourses(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { course_id, teacher_id, subject } = req.body || {};
    if (!course_id || !teacher_id) return res.status(400).json({ error: 'Datos incompletos' });

    // After migration: UNIQUE(teacher_id, course_id, subject)
    // A teacher CAN teach multiple subjects in the same course → each is a separate row
    // Check for exact duplicate (same teacher + course + subject)
    const subjectKey = (subject || '').trim();
    const { data: existing } = await sb.from('raice_teacher_courses')
      .select('id')
      .eq('course_id', course_id)
      .eq('teacher_id', teacher_id)
      .eq('subject', subjectKey)
      .maybeSingle();

    if (existing) return res.status(409).json({ error: `Este docente ya dicta "${subjectKey || 'esa materia'}" en este curso` });

    const { data: inserted, error } = await sb.from('raice_teacher_courses')
      .insert({ course_id, teacher_id, subject: subjectKey })
      .select().single();
    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'assign_teacher', `Docente ${teacher_id} asignado al curso ${course_id} — ${subjectKey || 'sin materia'}`);
    return res.status(200).json({ success: true, id: inserted.id });
  }

  if (req.method === 'DELETE') {
    const { id, course_id, teacher_id } = req.body || {};
    if (id) {
      // Delete by assignment id (and cascade deletes schedule slots)
      await sb.from('raice_teacher_courses').delete().eq('id', id);
    } else if (course_id && teacher_id) {
      await sb.from('raice_teacher_courses').delete().eq('course_id', course_id).eq('teacher_id', teacher_id);
    } else {
      return res.status(400).json({ error: 'ID requerido' });
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// TARDANZAS REPORT
// =====================================================
async function getTardanzasReport(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = parseInt(url.searchParams.get('days')) || 7;
  const since = todayCO(-days);

  const { data, error } = await sb.from('raice_attendance')
    .select('student_id, date, class_hour, course_id')
    .eq('status', 'T').gte('date', since)
    .order('date', { ascending: false });

  if (error) return res.status(500).json({ error: _dbErr(error) });

  // Aggregate by student
  const byStudent = {};
  (data || []).forEach(r => {
    if (!byStudent[r.student_id]) byStudent[r.student_id] = { student_id: r.student_id, count: 0, dates: [], course_id: r.course_id };
    byStudent[r.student_id].count++;
    if (!byStudent[r.student_id].dates.includes(r.date)) byStudent[r.student_id].dates.push(r.date);
  });

  // Get student names
  const ids = Object.keys(byStudent);
  if (!ids.length) return res.status(200).json({ tardanzas: [], period_days: days });

  const { data: students } = await sb.from('raice_students')
    .select('id, first_name, last_name, grade, course').in('id', ids);
  const sMap = {};
  (students || []).forEach(s => sMap[s.id] = s);

  const tardanzas = Object.values(byStudent)
    .map(t => ({
      ...t,
      student_name: sMap[t.student_id] ? `${sMap[t.student_id].first_name} ${sMap[t.student_id].last_name}` : '—',
      grade: sMap[t.student_id]?.grade,
      course: sMap[t.student_id]?.course,
      days_count: t.dates.length
    }))
    .sort((a, b) => b.count - a.count);

  return res.status(200).json({ tardanzas, period_days: days });
}

// =====================================================
// GLOBAL SEARCH
// =====================================================
async function globalSearch(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Strip cualquier caracter que no sea letra (incluyendo acentos), número, espacio o guion
  // Esto previene inyección en filtros PostgREST (.or() usa interpolación de string)
  const rawQ = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const q    = rawQ.replace(/[^\p{L}\p{N}\s\-']/gu, '').trim();
  if (q.length < 2) return res.status(200).json({ results: [] });

  // Escape ILIKE wildcards
  const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const term = `%${escaped}%`;

  // Sede scope para búsqueda de coordinadores — siempre leemos desde la BD, con sede_filter opcional
  const searchSedeFilter = url.searchParams.get('sede_filter');
  let searchCourseIds = null;
  let searchAdminSedeIds = null;
  if (user.role === 'admin') {
    searchAdminSedeIds = await getAdminSedeIds(sb, user, searchSedeFilter);
    if (searchAdminSedeIds && searchAdminSedeIds.length > 0) {
      const { data: scs } = await sb.from('raice_courses')
        .select('id').in('sede_id', searchAdminSedeIds).neq('type','subgroup');
      searchCourseIds = (scs||[]).map(c=>c.id);
    } else {
      searchCourseIds = ['00000000-0000-0000-0000-000000000000'];
    }
  }

  const [studentsRes, casesRes, teachersRes] = await Promise.all([
    (() => {
      let q2 = sb.from('raice_students').select('id, first_name, last_name, grade, course, phone')
        .or(`first_name.ilike.${term},last_name.ilike.${term}`)
        .eq('status','active').limit(8);
      if (searchCourseIds) q2 = q2.in('course_id', searchCourseIds.length ? searchCourseIds : ['00000000-0000-0000-0000-000000000000']);
      return q2;
    })(),
    (() => {
      let q2 = sb.from('raice_cases').select('id, student_name, type, status, created_at')
        .ilike('student_name', term).limit(5);
      if (searchCourseIds) q2 = q2.in('course_id', searchCourseIds.length ? searchCourseIds : ['00000000-0000-0000-0000-000000000000']);
      return q2;
    })(),
    user.role !== 'teacher'
      ? (() => {
          let q2 = sb.from('raice_users').select('id, first_name, last_name, username, role')
            .or(`first_name.ilike.${term},last_name.ilike.${term},username.ilike.${term}`)
            .eq('active',true).limit(5);
          if (user.role === 'admin') {
            if (searchAdminSedeIds && searchAdminSedeIds.length > 0) {
              q2 = q2.in('sede_id', searchAdminSedeIds);
            } else {
              q2 = q2.in('sede_id', ['00000000-0000-0000-0000-000000000000']);
            }
          }
          return q2;
        })()
      : Promise.resolve({ data: [] })
  ]);

  const results = [
    ...(studentsRes.data||[]).map(s => ({
      type: 'student', id: s.id,
      title: `${s.first_name} ${s.last_name}`,
      subtitle: `${s.grade === 0 ? 'Transición' : s.grade + '°'}${s.course}${s.phone ? ' · 📞 ' + s.phone : ''}`,
      icon: '👤'
    })),
    ...(casesRes.data||[]).map(c => ({
      type: 'case', id: c.id,
      title: c.student_name,
      subtitle: `Caso Tipo ${c.type} · ${c.status === 'open' ? 'Abierto' : 'Cerrado'}`,
      icon: '⚠️'
    })),
    ...(teachersRes.data||[]).map(t => ({
      type: 'user', id: t.id,
      title: `${t.first_name} ${t.last_name}`,
      subtitle: `@${t.username} · ${t.role === 'admin' ? 'Coordinador' : 'Docente'}`,
      icon: t.role === 'admin' ? '🏫' : '👨‍🏫'
    }))
  ];

  return res.status(200).json({ results, query: q });
}

// =====================================================
// STUDENT FICHA COMPLETA
// =====================================================
async function getStudentFicha(req, res, user) {
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const studentId = url.searchParams.get('id');
  const allObs = url.searchParams.get('all_obs') === '1';
  if (!studentId) return res.status(400).json({ error: 'ID requerido' });

  // Teachers can only view fichas of students in their courses
  if (user.role === 'teacher') {
    const { data: studentRow } = await sb.from('raice_students').select('course_id').eq('id', studentId).single();
    if (!studentRow) return res.status(404).json({ error: 'Estudiante no encontrado' });
    const { data: access } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', studentRow.course_id).limit(1);
    if (!access || !access.length) return res.status(403).json({ error: 'No tienes acceso a este estudiante' });
  }

  // Safe wrapper — never lets one failed query kill the whole response
  const safe = async (fn) => { try { const r = await fn(); return r; } catch (_) { return { data: null, error: _ }; } };

  const [studentRes, casesRes, obsRes, attRes, tardanzasRes, commitmentsRes] = await Promise.all([
    safe(() => sb.from('raice_students').select('*').eq('id', studentId).single()),
    safe(() => sb.from('raice_cases').select('id, type, description, status, created_at, teacher_id, course_id, actions_taken, notes, falta_descripcion, falta_categoria, falta_numeral, otros_involucrados, closed_at, closed_by').eq('student_id', studentId).order('created_at', { ascending: false })),
    safe(() => { let q = sb.from('raice_observations').select('id, type, text, created_at, teacher_id').eq('student_id', studentId).order('created_at', { ascending: false }); if (!allObs) q = q.limit(20); return q; }),
    safe(() => sb.from('raice_attendance').select('status, date, class_hour').eq('student_id', studentId).order('date', { ascending: false }).limit(120)),
    safe(() => sb.from('raice_attendance').select('date, class_hour').eq('student_id', studentId).eq('status','T').order('date', { ascending: false }).limit(20)),
    safe(() => sb.from('raice_commitments').select('id, description, due_date, fulfilled, case_id').eq('student_id', studentId).order('created_at', { ascending: false }))
  ]);

  if (!studentRes.data) return res.status(404).json({ error: 'Estudiante no encontrado' });

  // Fetch acudientes separately — table may not exist yet
  let acudientes = [];
  try {
    const { data: acudData } = await sb.from('raice_acudientes').select('*').eq('student_id', studentId).limit(5);
    acudientes = acudData || [];
  } catch (_) {}

  // Resolve teacher names for observations AND cases
  const obsData = obsRes.data || [];
  const casesData = casesRes.data || [];
  const allTeacherIds = [...new Set([
    ...obsData.map(o => o.teacher_id),
    ...casesData.map(c => c.teacher_id),
    ...casesData.map(c => c.closed_by)
  ].filter(Boolean))];
  const tMap = {};
  if (allTeacherIds.length) {
    const { data: teachers } = await sb.from('raice_users').select('id, first_name, last_name').in('id', allTeacherIds);
    (teachers || []).forEach(t => tMap[t.id] = `${t.first_name} ${t.last_name}`);
  }
  const obs = obsData.map(o => ({ ...o, teacher_name: tMap[o.teacher_id] || '—' }));

  // Resolve course names for cases
  const casesCourseIds = [...new Set(casesData.map(c => c.course_id).filter(Boolean))];
  const courseMap = {};
  if (casesCourseIds.length) {
    const { data: courses } = await sb.from('raice_courses').select('id, grade, number').in('id', casesCourseIds);
    (courses || []).forEach(c => courseMap[c.id] = `${c.grade}°${c.number || ''}`);
  }

  // Fetch followups, escalones, citaciones for all cases
  const caseIds = casesData.map(c => c.id).filter(Boolean);
  let followupsMap = {}, escalonesMap = {}, citacionesMap = {};
  const commitmentsData = commitmentsRes.data || [];
  if (caseIds.length) {
    const [fRes, eRes, ciRes] = await Promise.all([
      safe(() => sb.from('raice_followups').select('id, case_id, actions, descargos, status, created_at, coordinator_name').in('case_id', caseIds).order('created_at', { ascending: true })),
      safe(() => sb.from('raice_tipo1_escalones').select('id, case_id, numero_escalon, tipo_llamado, created_at').in('case_id', caseIds).order('numero_escalon', { ascending: true })),
      safe(() => sb.from('raice_citaciones').select('id, case_id, reason, date_time, attended, created_at').in('case_id', caseIds).order('created_at', { ascending: true }))
    ]);
    (fRes.data || []).forEach(f => { if (!followupsMap[f.case_id]) followupsMap[f.case_id] = []; followupsMap[f.case_id].push(f); });
    (eRes.data || []).forEach(e => { if (!escalonesMap[e.case_id]) escalonesMap[e.case_id] = []; escalonesMap[e.case_id].push(e); });
    (ciRes.data || []).forEach(ci => { if (!citacionesMap[ci.case_id]) citacionesMap[ci.case_id] = []; citacionesMap[ci.case_id].push(ci); });
  }

  // Build commitments map by case_id
  const commitmentsMap = {};
  commitmentsData.forEach(cm => {
    if (cm.case_id) {
      if (!commitmentsMap[cm.case_id]) commitmentsMap[cm.case_id] = [];
      commitmentsMap[cm.case_id].push(cm);
    }
  });

  // Enrich cases
  const enrichedCases = casesData.map(c => ({
    ...c,
    teacher_name: tMap[c.teacher_id] || '—',
    closed_by_name: c.closed_by ? (tMap[c.closed_by] || '—') : null,
    course_label: courseMap[c.course_id] || null,
    followups: followupsMap[c.id] || [],
    escalones: escalonesMap[c.id] || [],
    citaciones: citacionesMap[c.id] || [],
    commitments: commitmentsMap[c.id] || []
  }));

  // Attendance: deduplicate by date (last class_hour wins)
  // Attendance: use total records (hours) to match dashboard precision
  const attAll = attRes.data || [];
  const cntP  = attAll.filter(a => a.status === 'P').length;
  const cntA  = attAll.filter(a => a.status === 'A').length;
  const cntT  = attAll.filter(a => a.status === 'T').length;
  const cntPE = attAll.filter(a => a.status === 'PE').length;
  const cntS  = attAll.filter(a => a.status === 'S').length;

  const total = attAll.length;
  const countable = total - cntS - cntPE;
  const attPct = countable > 0 ? Math.round(((cntP + cntT) / countable) * 100) : (total - cntS > 0 ? 100 : null);

  // Build recent attendance array for mini-calendar (keep last 30 distinct dates for visual)
  const attByDate = {};
  attAll.forEach(a => {
    if (!attByDate[a.date] || (a.class_hour||1) > (attByDate[a.date].hour||1)) {
      attByDate[a.date] = { status: a.status, hour: a.class_hour||1 };
    }
  });
  const recentAtt = Object.entries(attByDate)
    .sort(([a],[b]) => b.localeCompare(a))
    .slice(0, 30)
    .map(([date, v]) => ({ date, status: v.status }));

  return res.status(200).json({
    student:      studentRes.data,
    cases:        enrichedCases,
    observations: obs,
    attendance:   { pct: attPct, present: cntP, permit: cntPE, absent: cntA, late: cntT, special: cntS, total: total, recent: recentAtt },
    tardanzas:    tardanzasRes.data || [],
    commitments:  commitmentsData,
    acudientes
  });
}

// =====================================================
// ACUDIENTES
// =====================================================
async function handleAcudientes(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const studentId = url.searchParams.get('student_id');
    // Accept token from Authorization header (preferred) or query param (legacy links)
    const authHeader = req.headers['authorization'] || '';
    const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null)
                  || url.searchParams.get('token');

    if (token) {
      // Public view for parents — verify token and check expiry
      const { data: acud } = await sb.from('raice_acudientes').select('student_id, access_token, token_expires_at').eq('access_token', token).single();
      if (!acud) return res.status(403).json({ error: 'Enlace inválido o expirado' });
      // Check expiry if set
      if (acud.token_expires_at && new Date(acud.token_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Este enlace ha expirado. Solicita uno nuevo al coordinador.' });
      }
      // Return limited student info
      const { data: student } = await sb.from('raice_students').select('first_name, last_name, grade, course').eq('id', acud.student_id).single();
      const { data: att } = await sb.from('raice_attendance').select('status, date, class_hour')
        .eq('student_id', acud.student_id).order('date', { ascending: false }).limit(30);
      const { data: tardanzas } = await sb.from('raice_attendance').select('date, class_hour')
        .eq('student_id', acud.student_id).eq('status','T').order('date', { ascending: false }).limit(10);
      return res.status(200).json({ student, attendance: att || [], tardanzas: tardanzas || [] });
    }

    requireRole(user, 'superadmin', 'admin');
    if (!studentId) return res.status(400).json({ error: 'student_id requerido' });
    const { data } = await sb.from('raice_acudientes').select('*').eq('student_id', studentId);
    return res.status(200).json({ acudientes: data || [] });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { student_id, name, phone, email, relationship } = req.body || {};
    if (!student_id || !name) return res.status(400).json({ error: 'Datos incompletos' });
    // Generate cryptographically secure access token for parent portal
    const { randomBytes } = await import('crypto');
    const token = randomBytes(24).toString('hex');
    // Token expires in 1 year from creation
    const expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb.from('raice_acudientes').insert({
      student_id, name, phone: phone || null, email: email || null,
      relationship: relationship || 'Acudiente', access_token: token,
      token_expires_at: expires_at
    }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, acudiente: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, name, phone, email, relationship } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'ID y nombre requeridos' });
    const updates = { name, phone: phone || null, email: email || null };
    if (relationship !== undefined) updates.relationship = relationship;
    const { error } = await sb.from('raice_acudientes').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin', 'admin');
    const { id } = req.body || {};
    await sb.from('raice_acudientes').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// CALENDARIO ESCOLAR
// =====================================================
async function handleCalendar(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'GET') {
    const url   = new URL(req.url, `http://${req.headers.host}`);
    const year  = parseInt(url.searchParams.get('year')) || new Date().getFullYear();
    const { data } = await sb.from('raice_calendar').select('*').eq('year', year).order('date');
    return res.status(200).json({ events: data || [] });
  }

  requireRole(user, 'superadmin', 'admin');

  if (req.method === 'POST') {
    const { date, name, type, year } = req.body || {};
    if (!date || !name) return res.status(400).json({ error: 'Datos incompletos' });
    const { error } = await sb.from('raice_calendar').insert({
      date, name, type: type || 'holiday', year: year || new Date(date).getFullYear()
    });
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    await sb.from('raice_calendar').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// CALENDARIO — RANGO DE FECHAS (inserción masiva)
// =====================================================
async function handleCalendarRange(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();

  const { date_from, date_to, type, name, exclude_weekends } = req.body || {};
  if (!date_from || !date_to || !type || !name) {
    return res.status(400).json({ error: 'date_from, date_to, type y name son obligatorios' });
  }

  const from = new Date(`${date_from}T12:00:00`);
  const to   = new Date(`${date_to}T12:00:00`);
  if (from > to) return res.status(400).json({ error: 'date_from debe ser anterior a date_to' });

  // Máximo 180 días de rango para evitar abuso
  const diffDays = Math.round((to - from) / 86400000);
  if (diffDays > 180) return res.status(400).json({ error: 'El rango no puede superar 180 días' });

  // Generar lista de fechas
  const rows = [];
  const cur  = new Date(from);
  while (cur <= to) {
    const dow = cur.getDay(); // 0=Dom, 6=Sáb
    if (!exclude_weekends || (dow !== 0 && dow !== 6)) {
      const dateStr = cur.toISOString().slice(0, 10);
      rows.push({ date: dateStr, name, type, year: parseInt(dateStr.slice(0, 4)) });
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (!rows.length) {
    return res.status(400).json({ error: 'No hay días hábiles en el rango seleccionado' });
  }

  // Upsert en bloques de 50 (ignorar duplicados por date+type si existen)
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await sb.from('raice_calendar').upsert(batch, {
      onConflict: 'date,type',
      ignoreDuplicates: true,
    });
    if (error) {
      // Si falla el upsert por falta de constraint único, caer a insert ignorando duplicados
      const { error: insErr, count } = await sb.from('raice_calendar').insert(batch, { count: 'exact' }).select();
      if (insErr) errors.push(insErr.message);
      else inserted += (count || batch.length);
    } else {
      inserted += batch.length;
    }
  }

  try {
    await sb.from('raice_logs').insert({
      user_id: user.id,
      event_type: 'calendar_range',
      detail: `Rango de ${rows.length} días (${date_from} → ${date_to}) tipo "${type}" agregado por @${user.username}`
    });
  } catch(_) {}

  return res.status(200).json({
    success: errors.length === 0,
    created: rows.length,
    errors,
    dates: rows.map(r => r.date),
  });
}

// =====================================================
// CALENDARIO HOY — estado del día actual (Bogotá)
// =====================================================
async function handleCalendarToday(req, res, user) {
  if (req.method !== 'GET') return res.status(405).end();
  const sb = getSupabase();

  // Fecha actual en zona horaria de Colombia
  const todayBogota = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());

  const { data: events } = await sb
    .from('raice_calendar')
    .select('*')
    .eq('date', todayBogota);

  // Tipos que bloquean asistencia (sin estudiantes en aula)
  const BLOCKING_TYPES = new Set(['holiday', 'vacation', 'teacher_meeting', 'union_day', 'institutional_day']);

  const allEvents = events || [];
  // Prioridad: primero un evento bloqueante, luego cualquier otro
  const blockingEvent  = allEvents.find(e => BLOCKING_TYPES.has(e.type));
  const infoEvent      = allEvents.find(e => !BLOCKING_TYPES.has(e.type));
  const primaryEvent   = blockingEvent || infoEvent || null;
  const blocksAttendance = !!blockingEvent;

  return res.status(200).json({
    date:               todayBogota,
    is_holiday:         allEvents.some(e => e.type === 'holiday'),
    blocks_attendance:  blocksAttendance,
    event:              primaryEvent,
    events:             allEvents,
  });
}

// =====================================================
// RECUPERAR CONTRASEÑA
// =====================================================
async function recoverPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!checkRateLimit(req, res)) return;
  const sb = getSupabase();
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Usuario requerido' });

  // Always return same response shape to prevent user enumeration
  const { data: user } = await sb.from('raice_users')
    .select('id, first_name, last_name, email, role').eq('username', username.toLowerCase()).eq('active', true).single();

  if (!user) return res.status(200).json({ success: false, message: 'Si el usuario existe, se generará una contraseña temporal.' });

  // Block recovery of superadmin accounts from public endpoint
  if (user.role === 'superadmin') return res.status(403).json({ error: 'Contacta al administrador del sistema' });

  // Generate cryptographically secure temp password
  const { randomBytes } = await import('crypto');
  const tempPass = randomBytes(5).toString('hex').toUpperCase();
  const hash = await bcrypt.hash(tempPass, 10);
  await sb.from('raice_users').update({ password_hash: hash, must_change_password: true }).eq('id', user.id);

  // Log the recovery so the coordinator can look it up in the logs panel
  await logActivity(sb, user.id, 'recover_password',
    `Contraseña temporal generada para @${username} — entrégala en mano: ${tempPass}`);

  // IMPORTANT: the temp password is NOT returned in the HTTP response.
  // The coordinator must retrieve it from the Registros (logs) panel in the admin interface.
  return res.status(200).json({
    success: true,
    message: `Contraseña temporal generada para ${user.first_name} ${user.last_name}. Consulta el panel de Registros para obtenerla y entrégala en mano al usuario.`,
    user_name: `${user.first_name} ${user.last_name}`
  });
}

// =====================================================
// REPORTS — ATTENDANCE EXPORT DATA
// =====================================================
async function reportAttendance(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date_from = url.searchParams.get('from') || todayCO();
  const date_to   = url.searchParams.get('to')   || date_from;

  const { data, error } = await sb.from('raice_attendance')
    .select('student_id, date, status, class_hour, course_id')
    .gte('date', date_from).lte('date', date_to)
    .order('date').order('course_id');

  if (error) return res.status(500).json({ error: _dbErr(error) });

  // Get students and courses in batch
  const sIds = [...new Set((data||[]).map(r => r.student_id).filter(Boolean))];
  const cIds = [...new Set((data||[]).map(r => r.course_id).filter(Boolean))];

  const [sRes, cRes] = await Promise.all([
    sIds.length ? sb.from('raice_students').select('id,first_name,last_name,grade,course').in('id', sIds) : { data: [] },
    cIds.length ? sb.from('raice_courses').select('id,grade,number').in('id', cIds) : { data: [] }
  ]);

  const sMap = {}, cMap = {};
  (sRes.data||[]).forEach(s => sMap[s.id] = s);
  (cRes.data||[]).forEach(c => cMap[c.id] = c);

  const rows = (data||[]).map(r => ({
    date:         r.date,
    class_hour:   r.class_hour || 1,
    status:       r.status,
    student_name: sMap[r.student_id] ? `${sMap[r.student_id].first_name} ${sMap[r.student_id].last_name}` : '—',
    grade:        sMap[r.student_id]?.grade || cMap[r.course_id]?.grade,
    course:       sMap[r.student_id]?.course || cMap[r.course_id]?.number
  }));

  return res.status(200).json({ rows, date_from, date_to });
}

// =====================================================
// REPORTS — CASES EXPORT DATA
// =====================================================
async function reportCases(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date_from = url.searchParams.get('from');
  const date_to   = url.searchParams.get('to');

  let query = sb.from('raice_cases')
    .select('id, student_name, grade, course, type, description, status, created_at, teacher_id')
    .order('created_at', { ascending: false });
  if (date_from) query = query.gte('created_at', date_from);
  if (date_to)   query = query.lte('created_at', date_to + 'T23:59:59');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: _dbErr(error) });

  // Get teacher names
  const tIds = [...new Set((data||[]).map(r => r.teacher_id).filter(Boolean))];
  const tMap = {};
  if (tIds.length) {
    const { data: teachers } = await sb.from('raice_users').select('id,first_name,last_name').in('id', tIds);
    (teachers||[]).forEach(t => tMap[t.id] = `${t.first_name} ${t.last_name}`);
  }

  const rows = (data||[]).map(r => ({
    ...r, teacher_name: tMap[r.teacher_id] || '—'
  }));

  return res.status(200).json({ rows, total: rows.length });
}

// =====================================================
// CRON — REPORTE SEMANAL AUTOMÁTICO (Viernes 6pm)
// =====================================================
async function cronWeeklyReport(req, res) {
  // Vercel cron calls with Authorization: Bearer <CRON_SECRET>
  // CRON_SECRET is REQUIRED — if not set, the endpoint is disabled for safety
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('⚠️  CRON_SECRET env var no está definida. Configúrala en Vercel para habilitar el reporte semanal.');
    return res.status(503).json({ error: 'Cron no configurado. Define CRON_SECRET en las variables de entorno de Vercel.' });
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });

  const sb   = getSupabase();
  const dateTo   = todayCO();
  const dateFrom = todayCO(-7);
  const weekLabel = `${dateFrom} al ${dateTo}`;

  // Gather all data for the week
  const [attRes, casesRes, tardanzasRes, studentsRes] = await Promise.all([
    sb.from('raice_attendance').select('student_id, date, status, class_hour').gte('date', dateFrom).lte('date', dateTo),
    sb.from('raice_cases').select('id, student_name, grade, course, type, status, created_at').gte('created_at', dateFrom + 'T00:00:00').lte('created_at', dateTo + 'T23:59:59'),
    sb.from('raice_attendance').select('student_id, date, class_hour').eq('status', 'T').gte('date', dateFrom).lte('date', dateTo),
    sb.from('raice_students').select('id').eq('status', 'active')
  ]);

  const att       = attRes.data     || [];
  const cases     = casesRes.data   || [];
  const tardanzas = tardanzasRes.data || [];
  const totalStudents = studentsRes.data?.length || 0;

  // Deduplicate attendance by student+date
  const attByStudentDate = {};
  att.forEach(a => {
    const key = `${a.student_id}_${a.date}`;
    if (!attByStudentDate[key] || (a.class_hour||1) > (attByStudentDate[key].hour||1)) {
      attByStudentDate[key] = { status: a.status, hour: a.class_hour||1 };
    }
  });
  const deduped   = Object.values(attByStudentDate);
  const present   = deduped.filter(a => a.status === 'P' || a.status === 'PE').length;
  const absent    = deduped.filter(a => a.status === 'A').length;
  const late      = deduped.filter(a => a.status === 'T').length;
  const attPct    = deduped.length > 0 ? Math.round((present / deduped.length) * 100) : null;

  // Top tardanzas students
  const tardanzaCount = {};
  tardanzas.forEach(t => { tardanzaCount[t.student_id] = (tardanzaCount[t.student_id]||0) + 1; });
  const topTardanzaIds = Object.entries(tardanzaCount).sort(([,a],[,b])=>b-a).slice(0,5).map(([id])=>id);
  let topTardanzaNames = [];
  if (topTardanzaIds.length) {
    const { data: students } = await sb.from('raice_students').select('id, first_name, last_name, grade, course').in('id', topTardanzaIds);
    topTardanzaNames = (students||[]).map(s => `${s.first_name} ${s.last_name} (${s.grade}°${s.course}) — ${tardanzaCount[s.id]} tardanza(s)`);
  }

  // New cases this week
  const newCases  = cases.filter(c => c.status === 'open');

  // Build the report summary (stored as notification to all admins)
  const reportText = [
    `📊 REPORTE SEMANAL — Semana del ${weekLabel}`,
    ``,
    `📋 ASISTENCIA`,
    `  • Total estudiantes activos: ${totalStudents}`,
    `  • Registros semana: ${deduped.length}`,
    `  • Asistencia promedio: ${attPct !== null ? attPct + '%' : '—'}`,
    `  • Presentes: ${present} | Ausentes: ${absent} | Tarde: ${late}`,
    ``,
    `⏰ TARDANZAS (${tardanzas.length} en total)`,
    ...(topTardanzaNames.map(n => `  • ${n}`)),
    ``,
    `⚠️ CASOS REGISTRADOS ESTA SEMANA: ${newCases.length}`,
    ...(newCases.slice(0,5).map(c => `  • Tipo ${c.type} — ${c.student_name} (${c.grade}°${c.course})`)),
    newCases.length > 5 ? `  • ... y ${newCases.length - 5} más` : ''
  ].filter(l => l !== undefined).join('\n');

  // Send notification to all coordinators
  const { data: admins } = await sb.from('raice_users').select('id').eq('role', 'admin').eq('active', true);
  const notifications = (admins||[]).map(admin => ({
    to_user_id:   admin.id,
    from_user_id: null,
    type:         'reporte_semanal',
    title:        `📊 Reporte Semanal — ${weekLabel}`,
    body:         reportText
  }));

  if (notifications.length) {
    await sb.from('raice_notifications').insert(notifications);
  }

  // Also send to superadmins
  const { data: superadmins } = await sb.from('raice_users').select('id').eq('role', 'superadmin').eq('active', true);
  if (superadmins?.length) {
    await sb.from('raice_notifications').insert(
      superadmins.map(u => ({
        to_user_id:   u.id,
        from_user_id: null,
        type:         'reporte_semanal',
        title:        `📊 Reporte Semanal — ${weekLabel}`,
        body:         reportText
      }))
    );
  }

  // Log it
  try { await sb.from('raice_logs').insert({ user_id: null, event_type: 'reporte_semanal', detail: `Reporte generado automáticamente: semana ${weekLabel}` }); } catch(_) {}

  return res.status(200).json({
    success:     true,
    week:        weekLabel,
    att_pct:     attPct,
    tardanzas:   tardanzas.length,
    new_cases:   newCases.length,
    notified:    (admins?.length || 0) + (superadmins?.length || 0)
  });
}

// =====================================================
// SCHEDULES — CRUD
// =====================================================
async function handleSchedules(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tcId     = url.searchParams.get('teacher_course_id');
    const courseId = url.searchParams.get('course_id');

    if (tcId) {
      const { data } = await sb.from('raice_schedules').select('*')
        .eq('teacher_course_id', tcId).order('day_of_week').order('class_hour');
      return res.status(200).json({ schedules: data || [] });
    }

    if (courseId) {
      // All schedules for a course (all teachers)
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id, subject, teacher_id, raice_users(first_name, last_name)')
        .eq('course_id', courseId);

      const tcIds = (tcRows || []).map(r => r.id);
      const tMap  = {};
      (tcRows || []).forEach(r => {
        tMap[r.id] = {
          subject:      r.subject || '—',
          teacher_name: r.raice_users ? `${r.raice_users.first_name} ${r.raice_users.last_name}` : '—',
          teacher_id:   r.teacher_id
        };
      });

      let schedules = [];
      if (tcIds.length) {
        const { data } = await sb.from('raice_schedules').select('*')
          .in('teacher_course_id', tcIds).order('day_of_week').order('class_hour');
        schedules = (data || []).map(s => ({
          ...s,
          ...tMap[s.teacher_course_id]
        }));
      }
      return res.status(200).json({ schedules, teachers: tcRows || [] });
    }

    return res.status(400).json({ error: 'teacher_course_id o course_id requerido' });
  }

  if (req.method === 'POST') {
    const { teacher_course_id, day_of_week, class_hour, start_time, end_time } = req.body || {};
    if (!teacher_course_id || !day_of_week || !class_hour)
      return res.status(400).json({ error: 'Datos incompletos' });

    // ── Resolve teacher_id and course_id from the teacher_course being assigned ──
    const { data: tcInfo } = await sb.from('raice_teacher_courses')
      .select('teacher_id, course_id, subject, raice_users(first_name, last_name)')
      .eq('id', teacher_course_id).single();
    if (!tcInfo) return res.status(400).json({ error: 'Asignación docente/materia no encontrada' });

    // ── 1. Conflict check: COURSE slot already taken ──
    // Get all teacher_course_ids that belong to the same course
    const { data: sameCourseTC } = await sb.from('raice_teacher_courses')
      .select('id').eq('course_id', tcInfo.course_id);
    const sameCourseIds = (sameCourseTC || []).map(r => r.id);

    if (sameCourseIds.length) {
      const { data: courseConflict } = await sb.from('raice_schedules')
        .select('id, teacher_course_id')
        .in('teacher_course_id', sameCourseIds)
        .eq('day_of_week', day_of_week)
        .eq('class_hour', class_hour);

      // Filter out the exact same teacher_course_id (upsert would just update it)
      const realCourseConflict = (courseConflict || []).filter(r => r.teacher_course_id !== teacher_course_id);
      if (realCourseConflict.length) {
        // Fetch details of the conflicting slot
        const conflictTcId = realCourseConflict[0].teacher_course_id;
        const { data: conflictTC } = await sb.from('raice_teacher_courses')
          .select('subject, raice_users(first_name, last_name)')
          .eq('id', conflictTcId).single();
        const cName = conflictTC?.raice_users ? `${conflictTC.raice_users.first_name} ${conflictTC.raice_users.last_name}` : 'otro docente';
        const cSubj = conflictTC?.subject || 'otra materia';
        const dayNames = {1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes'};
        return res.status(409).json({
          error: `⚠️ Cruce de horario en el curso: el ${dayNames[day_of_week]} a la ${class_hour}ª hora ya está asignado a "${cSubj}" con ${cName}.`
        });
      }
    }

    // ── 2. Conflict check: TEACHER already busy at that day/hour in another course ──
    const { data: sameTeacherTC } = await sb.from('raice_teacher_courses')
      .select('id, course_id, subject').eq('teacher_id', tcInfo.teacher_id);
    const sameTeacherIds = (sameTeacherTC || []).map(r => r.id);

    if (sameTeacherIds.length) {
      const { data: teacherConflict } = await sb.from('raice_schedules')
        .select('id, teacher_course_id')
        .in('teacher_course_id', sameTeacherIds)
        .eq('day_of_week', day_of_week)
        .eq('class_hour', class_hour);

      // Filter out exact same teacher_course_id (upsert) and same course (already checked above)
      const realTeacherConflict = (teacherConflict || []).filter(r =>
        r.teacher_course_id !== teacher_course_id &&
        !(sameCourseIds.includes(r.teacher_course_id))
      );
      if (realTeacherConflict.length) {
        const conflictTcId = realTeacherConflict[0].teacher_course_id;
        const conflictTCInfo = (sameTeacherTC || []).find(r => r.id === conflictTcId);
        // Get course name
        const { data: conflictCourse } = await sb.from('raice_courses')
          .select('grade, number').eq('id', conflictTCInfo?.course_id).single();
        const courseLabel = conflictCourse ? `${conflictCourse.grade}°${conflictCourse.number}` : 'otro curso';
        const tName = tcInfo.raice_users ? `${tcInfo.raice_users.first_name} ${tcInfo.raice_users.last_name}` : 'El docente';
        const dayNames = {1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes'};
        return res.status(409).json({
          error: `⚠️ Cruce de horario del docente: ${tName} ya tiene "${conflictTCInfo?.subject || 'otra materia'}" en ${courseLabel} el ${dayNames[day_of_week]} a la ${class_hour}ª hora.`
        });
      }
    }

    // ── No conflicts — proceed with upsert ──
    const { error } = await sb.from('raice_schedules').upsert({
      teacher_course_id, day_of_week, class_hour,
      start_time: start_time || null, end_time: end_time || null
    }, { onConflict: 'teacher_course_id,day_of_week,class_hour' });

    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    await sb.from('raice_schedules').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// SCHEDULES OVERVIEW — All courses, all teachers, real-time
// =====================================================
async function getSchedulesOverview(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  if (req.method !== 'GET') return res.status(405).end();
  const sb    = getSupabase();
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const today = todayCO();
  const todayDow = dayOfWeekCO(today);
  const weekMonday = todayCO(-(todayDow - 1));
  const weekFriday = todayCO(5 - todayDow);
  // Never include future dates — PE records from excusas can exist for future days
  const attThrough = weekFriday > today ? today : weekFriday;

  // Sede filter — rector/superadmin can narrow to one sede; admin always scoped to their sedes
  const sedeFilterParam = url.searchParams.get('sede_filter');
  let sedeCourseIds = null;
  if (user.role === 'admin') {
    const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilterParam);
    sedeCourseIds = await getCourseIdsForSedes(sb, adminSedeIds);
  } else if (sedeFilterParam) {
    sedeCourseIds = await getCourseIdsForSedes(sb, [sedeFilterParam]);
  }

  // A full week of attendance is thousands of student rows and exceeds PostgREST's
  // default 1000-row cap. Without pagination only the first 1000 rows come back, so
  // the most recently entered day (today) falls outside the page and the whole day
  // shows as "Pendiente". Paginate so the map sees every record.
  async function fetchWeekAttendance() {
    const PAGE = 1000;
    let all  = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb.from('raice_attendance')
        .select('course_id, class_hour, teacher_id, date')
        .gte('date', weekMonday)
        .lte('date', attThrough)
        .not('status', 'in', '("NR","PE")')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return { error };
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return { data: all };
  }

  const [schedsRes, bellRes, attRes] = await Promise.all([
    sb.from('raice_schedules')
      .select(`
        id, day_of_week, class_hour,
        teacher_course_id,
        raice_teacher_courses!inner(
          id, subject, teacher_id, course_id,
          raice_users(id, first_name, last_name),
          raice_courses(id, grade, number, section, type, name)
        )
      `)
      .order('day_of_week').order('class_hour'),
    sb.from('raice_bell_schedule').select('*').order('class_hour'),
    fetchWeekAttendance()
  ]);

  if (schedsRes.error) return res.status(500).json({ error: 'Error al cargar horarios' });
  if (attRes.error)    return res.status(500).json({ error: 'Error al cargar asistencias' });

  // Set of "course_hour_dow" keys where attendance was taken this week.
  // Intentionally NOT keyed by teacher_id: a coordinator or substitute may take
  // attendance for an absent teacher, and the slot must still show as taken.
  const attSet = new Set((attRes.data || []).map(a =>
    `${a.course_id}_${a.class_hour}_${dayOfWeekCO(a.date)}`
  ));

  // Apply sede filter on course_id if required
  const courseSet = sedeCourseIds ? new Set(sedeCourseIds) : null;
  const filteredScheds = courseSet
    ? (schedsRes.data || []).filter(s => courseSet.has(s.raice_teacher_courses?.course_id))
    : (schedsRes.data || []);

  const schedules = filteredScheds.map(s => {
    const tc     = s.raice_teacher_courses;
    const course = tc?.raice_courses;
    const teacher = tc?.raice_users;
    return {
      id:               s.id,
      day_of_week:      s.day_of_week,
      class_hour:       s.class_hour,
      teacher_course_id: s.teacher_course_id,
      subject:          tc?.subject   || '—',
      teacher_id:       tc?.teacher_id,
      teacher_name:     teacher ? `${teacher.first_name} ${teacher.last_name}` : '—',
      course_id:        tc?.course_id,
      grade:            course?.grade,
      number:           course?.number,
      section:          course?.section || String(course?.number || ''),
      type:             course?.type    || 'normal',
      course_name:      course?.name    || null,
      attendance_taken: attSet.has(`${tc?.course_id}_${s.class_hour}_${s.day_of_week}`)
    };
  });

  return res.status(200).json({
    schedules,
    bell_schedule: bellRes.data || [],
    today,
    today_dow: todayDow
  });
}

// =====================================================
// BELL SCHEDULE — Global class times config
// =====================================================
async function handleBellSchedule(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { data } = await sb.from('raice_bell_schedule')
      .select('*').order('class_hour');
    return res.status(200).json({ bell_schedule: data || [] });
  }

  requireRole(user, 'superadmin');

  if (req.method === 'POST') {
    const { class_hour, start_time, end_time, label } = req.body || {};
    if (!class_hour) return res.status(400).json({ error: 'Número de hora requerido' });
    const { error } = await sb.from('raice_bell_schedule').upsert(
      {
        class_hour,
        start_time: start_time || null,
        end_time:   end_time   || null,
        label:      label      || null
      },
      { onConflict: 'class_hour' }
    );
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { class_hour } = req.body || {};
    if (!class_hour) return res.status(400).json({ error: 'Número de hora requerido' });
    const { error } = await sb.from('raice_bell_schedule').delete().eq('class_hour', class_hour);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// TEACHER SCHEDULE — Full weekly view for one teacher
// =====================================================
async function getTeacherSchedule(req, res, user) {
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Teachers can only see their own schedule; admins/superadmins/rector can query any teacher_id
  let teacherId;
  if (['superadmin', 'admin', 'rector'].includes(user.role)) {
    teacherId = url.searchParams.get('teacher_id') || user.id;
  } else {
    teacherId = user.id; // teachers always see only their own schedule
  }

  const { data: tc } = await sb.from('raice_teacher_courses')
    .select('id, subject, course_id, raice_courses(grade, number, section, type, name)')
    .eq('teacher_id', teacherId);

  const tcIds = (tc || []).map(r => r.id);
  const tcMap = {};
  (tc || []).forEach(r => tcMap[r.id] = r);

  let schedules = [];
  if (tcIds.length) {
    const { data } = await sb.from('raice_schedules').select('*')
      .in('teacher_course_id', tcIds).order('day_of_week').order('class_hour');
    schedules = (data || []).map(s => {
      const row = tcMap[s.teacher_course_id] || {};
      const c   = row.raice_courses || {};
      const isSubgroup = c.type === 'subgroup';
      return {
        ...s,
        subject:      row.subject || null,
        grade:        c.grade,
        course_num:   c.number,
        section:      isSubgroup ? null : (c.section || (c.number != null ? String(c.number) : null)),
        course_id:    row.course_id,
        course_type:  c.type || 'normal',
        course_name:  c.name || null
      };
    });
  }

  const { data: bell } = await sb.from('raice_bell_schedule')
    .select('*').order('class_hour');

  return res.status(200).json({ schedules, bell_schedule: bell || [] });
}

// =====================================================
// PURGE — Superadmin only data maintenance
// =====================================================
async function handlePurge(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'DELETE') return res.status(405).end();
  const sb = getSupabase();
  const { target, date_from, date_to, before, status, mode } = req.body || {};

  if (target === 'attendance') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });
    const { error, count } = await sb.from('raice_attendance')
      .delete({ count: 'exact' }).gte('date', date_from).lte('date', date_to);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', `Asistencia eliminada: ${date_from} a ${date_to}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'attendance_nr') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });
    // Delete records where status is null or explicitly 'NR' (if used)
    const { error, count } = await sb.from('raice_attendance')
      .delete({ count: 'exact' })
      .gte('date', date_from)
      .lte('date', date_to)
      .or('status.is.null,status.eq.NR');
    
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', `Asistencia NR eliminada: ${date_from} a ${date_to}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'cases') {
    // Get IDs before deletion to clean up orphan notifications
    let qIds = sb.from('raice_cases').select('id');
    if (status === 'all') {
      qIds = qIds.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      qIds = qIds.eq('status', status || 'closed');
    }
    const { data: toDelete } = await qIds;
    const caseIdsToDelete = (toDelete||[]).map(c => c.id);

    // Delete the cases
    let q = sb.from('raice_cases').delete({ count: 'exact' });
    if (status === 'all') {
      q = q.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      q = q.eq('status', status || 'closed');
    }
    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    // Mark notifications for deleted cases as read (removes from Alertas)
    if (caseIdsToDelete.length) {
      await sb.from('raice_notifications')
        .update({ read: true }).in('link_id', caseIdsToDelete);
    }

    await logActivity(sb, user.id, 'purge', `Casos eliminados: ${status || 'closed'}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'citations') {
    const { error, count } = await sb.from('raice_citations').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', 'Citaciones eliminadas');
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'logs') {
    if (!before) return res.status(400).json({ error: 'Fecha límite requerida' });
    const { error, count } = await sb.from('raice_logs')
      .delete({ count: 'exact' }).lt('created_at', before);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── RETIROS DE CLASE ──────────────────────────────────────
  if (target === 'removals') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });

    // Check how many are linked to open RAICE cases (via student_id + date overlap)
    const { data: removalRows } = await sb.from('raice_classroom_removals')
      .select('student_id').gte('date', date_from).lte('date', date_to);

    let linkedToOpenCases = 0;
    if (removalRows?.length) {
      const studentIds = [...new Set(removalRows.map(r => r.student_id).filter(Boolean))];
      if (studentIds.length) {
        const { count } = await sb.from('raice_cases')
          .select('id', { count: 'exact', head: true })
          .in('student_id', studentIds).neq('status', 'closed');
        linkedToOpenCases = count || 0;
      }
    }

    const { error, count } = await sb.from('raice_classroom_removals')
      .delete({ count: 'exact' }).gte('date', date_from).lte('date', date_to);
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Retiros eliminados: ${date_from} a ${date_to} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count, linked_to_open_cases: linkedToOpenCases });
  }

  // ── EVASIONES ─────────────────────────────────────────────
  if (target === 'evasions') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });

    // Evasions are stored as notifications with type='evasion'
    // mode: 'read' = only read/processed, 'all' = everything in range
    let q = sb.from('raice_notifications')
      .delete({ count: 'exact' })
      .eq('type', 'evasion')
      .gte('created_at', date_from + 'T00:00:00')
      .lte('created_at', date_to + 'T23:59:59');

    if (mode === 'read') {
      q = q.eq('read', true);
    }
    // mode === 'all' → no extra filter

    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Evasiones eliminadas: ${date_from} a ${date_to} — modo: ${mode || 'all'} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── NOTIFICACIONES / ALERTAS ──────────────────────────────
  if (target === 'notifications') {
    const notif_type = req.body?.notif_type || 'all';
    const before     = req.body?.before;

    let q = sb.from('raice_notifications').delete({ count: 'exact' });

    if (notif_type === 'read') {
      q = q.eq('read', true);
    } else if (notif_type !== 'all') {
      q = q.eq('type', notif_type);
    }

    if (before) {
      q = q.lte('created_at', before + 'T23:59:59');
    }

    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Notificaciones eliminadas — tipo: ${notif_type}${before ? ' antes de ' + before : ''} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── OMISIONES DE ASISTENCIA (registro masivo NR) ──────────
  if (target === 'omissions') {
    const date = req.body?.date;
    if (!date) return res.status(400).json({ error: 'Fecha requerida' });

    const dow = dayOfWeekCO(date);

    // Todas las sesiones programadas para ese día de la semana
    const { data: scheds, error: schedErr } = await sb.from('raice_schedules')
      .select('class_hour, raice_teacher_courses(teacher_id, course_id)')
      .eq('day_of_week', dow);
    if (schedErr) return res.status(500).json({ error: _dbErr(schedErr) });
    if (!scheds || scheds.length === 0) {
      return res.status(200).json({ success: true, sessions: 0, registered: 0 });
    }

    // Sesiones que ya tienen asistencia registrada para esa fecha
    const { data: existing } = await sb.from('raice_attendance')
      .select('course_id, class_hour').eq('date', date);
    const takenSet = new Set((existing || []).map(a => `${a.course_id}_${a.class_hour}`));

    // Sesiones faltantes deduplicadas por course_id + class_hour
    const sessionMap = new Map();
    for (const s of scheds) {
      const tc = s.raice_teacher_courses;
      if (!tc?.course_id) continue;
      const key = `${tc.course_id}_${s.class_hour}`;
      if (!takenSet.has(key) && !sessionMap.has(key)) {
        sessionMap.set(key, { course_id: tc.course_id, teacher_id: tc.teacher_id, class_hour: s.class_hour });
      }
    }

    if (sessionMap.size === 0) {
      return res.status(200).json({ success: true, sessions: 0, registered: 0 });
    }

    const now = new Date().toISOString();
    let totalRegistered = 0;

    for (const session of sessionMap.values()) {
      const { data: students } = await sb.from('raice_students')
        .select('id').eq('course_id', session.course_id).eq('status', 'active');
      if (!students?.length) continue;

      const rows = students.map(s => ({
        student_id:        s.id,
        course_id:         session.course_id,
        teacher_id:        session.teacher_id || user.id,
        date,
        class_hour:        session.class_hour,
        status:            'NR',
        corrected_by:      user.id,
        corrected_at:      now,
        correction_reason: 'omision_docente_bulk',
      }));

      let { error: insErr } = await sb.from('raice_attendance').insert(rows);
      if (insErr && (insErr.message.includes('corrected_by') || insErr.message.includes('correction_reason'))) {
        const rowsBasic = rows.map(({ corrected_by: _a, corrected_at: _b, correction_reason: _c, ...rest }) => rest);
        const r2 = await sb.from('raice_attendance').insert(rowsBasic);
        insErr = r2.error;
      }
      if (!insErr) totalRegistered += students.length;
    }

    await logActivity(sb, user.id, 'purge',
      `Omisiones en bloque — ${date} — ${sessionMap.size} sesiones — ${totalRegistered} registros NR — por @${user.username}`);
    return res.status(200).json({ success: true, sessions: sessionMap.size, registered: totalRegistered });
  }

  return res.status(400).json({ error: 'Target no válido' });
}


// =====================================================
// BACKUP — JSON export, Excel/CSV, Email via Resend
// =====================================================

async function handleBackupExport(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb = getSupabase();

  try {
    // Pagina una tabla completa sin límite de filas (Supabase max = 1000 por query)
    async function fetchAll(table, orderCol = 'id', ascending = true) {
      let all = [];
      let from = 0;
      const PAGE = 1000;
      while (true) {
        try {
          const { data, error } = await sb.from(table).select('*')
            .order(orderCol, { ascending }).range(from, from + PAGE - 1);
          if (error || !data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < PAGE) break;
          from += PAGE;
        } catch (_) { break; }
      }
      return all;
    }

    // Todas las tablas se pagina para garantizar completitud total
    const [
      students,
      cases,
      followups,
      citations,
      commitments,
      observations,
      acudientes,
      teachers,
      courses,
      schedules,
      bellSchedule,
      teacherCourses,
      teacherAbsences,
      absenceReplacements,
      suspensions,
      classroomRemovals,
      excusas,
      faltas,
      periods,
      config,
      calendar,
      notifications,
      studentGradeHistory,
      logs,
      tipo1Escalones,
      sedes,
      userSedes,
      subgroupMembers,
      attendance,
    ] = await Promise.all([
      fetchAll('raice_students',              'last_name'),
      fetchAll('raice_cases',                 'created_at', false),
      fetchAll('raice_followups',             'created_at', false),
      fetchAll('raice_citations',             'created_at', false),
      fetchAll('raice_commitments',           'due_date',   false),
      fetchAll('raice_observations',          'created_at', false),
      fetchAll('raice_acudientes',            'id'),
      fetchAll('raice_users',                 'first_name'),   // incluye superadmin para recuperación total
      fetchAll('raice_courses',               'grade'),
      fetchAll('raice_schedules',             'id'),
      fetchAll('raice_bell_schedule',         'class_hour'),
      fetchAll('raice_teacher_courses',       'id'),
      fetchAll('raice_teacher_absences',      'date',       false),
      fetchAll('raice_absence_replacements',  'id'),
      fetchAll('raice_suspensions',           'created_at', false),
      fetchAll('raice_classroom_removals',    'created_at', false),
      fetchAll('raice_excusas',               'date',       false),
      fetchAll('raice_faltas_catalogo',       'id'),
      fetchAll('raice_periods',               'created_at', false),
      fetchAll('raice_config',                'id'),
      fetchAll('raice_calendar',              'date',       false),
      fetchAll('raice_notifications',         'created_at', false),
      fetchAll('raice_student_grade_history', 'changed_at', false),
      fetchAll('raice_logs',                  'created_at', false),
      fetchAll('raice_tipo1_escalones',       'created_at', false),
      fetchAll('raice_sedes',                 'created_at'),
      fetchAll('raice_user_sedes',            'user_id'),
      fetchAll('raice_subgroup_members',      'id'),
      fetchAll('raice_attendance',            'date',       false),
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      version: '3.0',
      totals: {
        students:              students.length,
        attendance:            attendance.length,
        cases:                 cases.length,
        followups:             followups.length,
        citations:             citations.length,
        commitments:           commitments.length,
        observations:          observations.length,
        acudientes:            acudientes.length,
        users:                 teachers.length,
        role_superadmin:       teachers.filter(u => u.role === 'superadmin').length,
        role_teachers:         teachers.filter(u => u.role === 'teacher').length,
        role_coordinators:     teachers.filter(u => u.role === 'admin').length,
        role_rectores:         teachers.filter(u => u.role === 'rector').length,
        courses:               courses.length,
        schedules:             schedules.length,
        bell_schedule:         bellSchedule.length,
        teacher_courses:       teacherCourses.length,
        teacher_absences:      teacherAbsences.length,
        absence_replacements:  absenceReplacements.length,
        suspensions:           suspensions.length,
        classroom_removals:    classroomRemovals.length,
        excusas:               excusas.length,
        faltas_catalogo:       faltas.length,
        periods:               periods.length,
        calendar:              calendar.length,
        notifications:         notifications.length,
        student_grade_history: studentGradeHistory.length,
        logs:                  logs.length,
        tipo1_escalones:       tipo1Escalones.length,
      },
      tables: {
        // Datos operativos principales
        students,
        attendance,
        cases,
        followups,
        citations,
        commitments,
        observations,
        acudientes,
        // Usuarios y estructura académica
        teachers,
        courses,
        schedules,
        bell_schedule:          bellSchedule,
        teacher_courses:        teacherCourses,
        teacher_absences:       teacherAbsences,
        absence_replacements:   absenceReplacements,
        // Convivencia extendida
        suspensions,
        classroom_removals:     classroomRemovals,
        excusas,
        // Configuración del colegio
        faltas_catalogo:        faltas,
        periods,
        config,
        calendar,
        // Sedes (multi-sede)
        sedes,
        user_sedes:             userSedes,
        subgroup_members:       subgroupMembers,
        // Sistema
        notifications,
        student_grade_history:  studentGradeHistory,
        logs,
        tipo1_escalones:        tipo1Escalones,
      }
    };

    try {
      await sb.from('raice_logs').insert({
        user_id: user.id,
        event_type: 'backup_export',
        detail: `Backup completo v3.0 exportado por @${user.username} — ${attendance.length} registros de asistencia, ${students.length} estudiantes, ${cases.length} casos`
      });
    } catch(_) {}

    const json = JSON.stringify(backup);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="raice-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.status(200);
    res.end(json);
  } catch (backupErr) {
    console.error('Backup export error:', backupErr?.message, backupErr?.stack);
    return res.status(500).json({ error: 'Error al generar el backup. Inténtalo de nuevo.' });
  }
}

async function handleBackupCsv(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'students';
  const sheets = {};

  if (type === 'students' || type === 'full') {
    const { data } = await sb.from('raice_students').select('*').order('grade').order('last_name');
    sheets['Estudiantes'] = (data || []).map(s => ({
      'Grado': s.grade, 'Curso': s.course,
      'Apellidos': s.last_name, 'Nombres': s.first_name,
      'Tipo Doc': s.doc_type, 'Número Doc': s.doc_number,
      'Fecha Nac': s.birth_date, 'Estado': s.status, 'Notas': s.notes || ''
    }));
  }

  if (type === 'attendance' || type === 'full') {
    const { data } = await sb.from('raice_attendance')
      .select('date, status, class_hour, student_id')
      .order('date', { ascending: false }).limit(20000);
    sheets['Asistencia'] = (data || []).map(r => ({
      'Fecha': r.date, 'Hora': r.class_hour,
      'Student ID': r.student_id || '',
      'Estado': r.status === 'P' ? 'Presente' : r.status === 'A' ? 'Ausente' : r.status === 'T' ? 'Tarde' : 'Con permiso'
    }));
  }

  if (type === 'cases' || type === 'full') {
    const { data } = await sb.from('raice_cases').select('*').order('created_at', { ascending: false });
    sheets['Casos'] = (data || []).map(c => ({
      'Fecha': c.created_at?.split('T')[0], 'Tipo': c.type,
      'Estudiante': c.student_name, 'Grado': c.grade, 'Curso': c.course,
      'Descripción': c.description, 'Estado': c.status,
      'Docente': c.teacher_name || ''
    }));
  }

  if (type === 'teachers' || type === 'full') {
    const { data } = await sb.from('raice_users')
      .select('first_name, last_name, username, email, role, active, last_login')
      .in('role', ['teacher','admin']).order('first_name');
    sheets['Docentes'] = (data || []).map(u => ({
      'Apellidos': u.last_name, 'Nombres': u.first_name,
      'Usuario': u.username, 'Correo': u.email || '',
      'Rol': u.role === 'teacher' ? 'Docente' : 'Coordinador',
      'Activo': u.active ? 'Sí' : 'No',
      'Último acceso': u.last_login ? u.last_login.split('T')[0] : ''
    }));
  }

  if (!Object.keys(sheets).length) return res.status(400).json({ error: 'Tipo no válido' });

  try { await sb.from('raice_logs').insert({ user_id: user.id, event_type: 'backup_excel', detail: `Excel exportado (${type}) por @${user.username}` }); } catch(_) {}

  return res.status(200).json({ sheets });
}

async function handleBackupEmail(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { email: overrideEmail, test } = req.body || {};

  const { data: config } = await sb.from('raice_config').select('*').eq('id', 1).maybeSingle();
  const destEmail  = overrideEmail || config?.backup_email;
  const resendKey  = process.env.RESEND_API_KEY || config?.resend_api_key;
  const schoolName = config?.school_name || 'RAICE';

  if (!destEmail) return res.status(400).json({ error: 'No hay correo destino configurado' });
  if (!resendKey) return res.status(400).json({ error: 'No hay clave de Resend configurada. Agrégala en Configuración o como variable de entorno RESEND_API_KEY.' });

  const sq2 = (p) => p.then(r => r.data || []).catch(() => []);
  const [students, attendance, cases, courses] = await Promise.all([
    sq2(sb.from('raice_students').select('*').order('grade').order('last_name')),
    sq2(sb.from('raice_attendance').select('*').order('date', { ascending: false }).limit(30000)),
    sq2(sb.from('raice_cases').select('*').order('created_at', { ascending: false })),
    sq2(sb.from('raice_courses').select('*').order('grade')),
  ]);

  const backupJson   = JSON.stringify({ exported_at: new Date().toISOString(), school: schoolName,
    tables: { students, attendance, cases, courses }
  }, null, 2);
  const backupBase64 = Buffer.from(backupJson).toString('base64');
  const date         = todayCO();
  const stats        = { estudiantes: students.length, asistencia: attendance.length, casos: cases.length };

  const emailBody = `
    <h2>💾 Backup RAICE — ${schoolName}</h2>
    <p>Generado: <strong>${new Date().toLocaleString('es-CO')}</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>👥 Estudiantes</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.estudiantes}</td></tr>
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>📋 Registros asistencia</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.asistencia}</td></tr>
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>⚠️ Casos RAICE</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.casos}</td></tr>
    </table>
    <p style="margin-top:16px;color:#64748b;font-size:13px;">Adjunto: <code>raice_backup_${date}.json</code>${test ? ' — <strong style="color:#f59e0b;">ENVÍO DE PRUEBA</strong>' : ''}</p>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'backup@raice.app',
      to: [destEmail],
      subject: `${test ? '[PRUEBA] ' : ''}Backup RAICE — ${schoolName} — ${date}`,
      html: emailBody,
      attachments: [{ filename: `raice_backup_${date}.json`, content: backupBase64 }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return res.status(500).json({ error: err.message || 'Error al enviar con Resend' });
  }

  try { await sb.from('raice_logs').insert({ user_id: user.id, event_type: 'backup_email', detail: `Backup enviado a ${destEmail}${test ? ' (prueba)' : ''}` }); } catch(_) {}

  return res.status(200).json({ success: true, sent_to: destEmail });
}

// =====================================================
// DIRECTOR DE GRADO — casos del grado (solo lectura)
// =====================================================
async function getGradeCases(req, res, user) {
  const sb = getSupabase();

  // Buscar si este docente es director de algún curso
  // Usar limit instead of .single() to avoid error when no rows found
  const { data: courses } = await sb.from('raice_courses')
    .select('id, grade, number')
    .eq('director_id', user.id)
    .limit(1);

  const course = courses && courses[0];

  // Si no es director de ningún curso, retornar indicador
  if (!course) {
    return res.status(200).json({ is_director: false, cases: [] });
  }

  // Obtener todos los casos del curso donde es director:
  // Buscar por course_id (relacion directa) O por grade+course (casos sin course_id asignado)
  const [byId, byGrade] = await Promise.all([
    sb.from('raice_cases')
      .select('id, student_name, grade, course, course_id, type, description, actions_taken, notes, status, created_at, teacher_id')
      .eq('course_id', course.id)
      .order('created_at', { ascending: false }),
    sb.from('raice_cases')
      .select('id, student_name, grade, course, course_id, type, description, actions_taken, notes, status, created_at, teacher_id')
      .is('course_id', null)
      .eq('grade', course.grade)
      .eq('course', course.number)
      .order('created_at', { ascending: false })
  ]);

  if (byId.error && byGrade.error) return res.status(500).json({ error: 'Error al cargar casos del grado' });

  // Merge and deduplicate by id
  const seen = new Set();
  const casesData = [...(byId.data || []), ...(byGrade.data || [])]
    .filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));


  // Enriquecer con nombre del docente que reportó
  const teacherIds = [...new Set((casesData || []).map(c => c.teacher_id).filter(Boolean))];
  const teacherMap = {};
  if (teacherIds.length > 0) {
    const { data: teachers } = await sb.from('raice_users')
      .select('id, first_name, last_name').in('id', teacherIds);
    (teachers || []).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
  }

  const cases = (casesData || []).map(c => ({
    ...c,
    teacher_name: teacherMap[c.teacher_id] || '—',
    // Normalizar tipo para el frontend
    type_label: c.type === 1 ? 'Tipo I' : c.type === 2 ? 'Tipo II' : c.type === 3 ? 'Tipo III' : `Tipo ${c.type}`,
    status_label: c.status === 'open' ? 'Abierto' : c.status === 'tracking' ? 'En seguimiento' : c.status === 'closed' ? 'Cerrado' : c.status
  }));

  return res.status(200).json({
    is_director: true,
    course: { id: course.id, grade: course.grade, number: course.number },
    cases
  });
}

// =====================================================
// EVASIONES — listado para coordinador/admin
// =====================================================
// =====================================================
// AUSENCIAS DOCENTES Y REEMPLAZOS
// =====================================================

async function handleTeacherAbsences(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  // Rector is read-only — writes already blocked globally, but also block here for clarity
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const date = url.searchParams.get('date') || todayCO();

    // Get absences for the day with teacher name
    const { data: absences, error } = await sb
      .from('raice_teacher_absences')
      .select('id, teacher_id, date, hours_absent, reason, created_at')
      .eq('date', date)
      .order('created_at');
    if (error) return res.status(500).json({ error: _dbErr(error) });

    if (!absences?.length) return res.status(200).json({ absences: [] });

    // Batch: teacher names
    const teacherIds = [...new Set(absences.map(a => a.teacher_id))];
    const { data: teachers } = await sb.from('raice_users')
      .select('id, first_name, last_name').in('id', teacherIds);
    const teacherMap = {};
    (teachers || []).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);

    // Batch: replacements for these absences
    const absenceIds = absences.map(a => a.id);
    const { data: replacements } = await sb
      .from('raice_absence_replacements')
      .select('id, absence_id, replacement_teacher_id, class_hour, course_id')
      .in('absence_id', absenceIds);

    // Replacement teacher names + course labels
    const repTeacherIds = [...new Set((replacements || []).map(r => r.replacement_teacher_id))];
    const repCourseIds  = [...new Set((replacements || []).map(r => r.course_id).filter(Boolean))];
    const [repTeachers, repCourses] = await Promise.all([
      repTeacherIds.length
        ? sb.from('raice_users').select('id, first_name, last_name').in('id', repTeacherIds)
        : { data: [] },
      repCourseIds.length
        ? sb.from('raice_courses').select('id, grade, number').in('id', repCourseIds)
        : { data: [] }
    ]);
    const repTeacherMap = {};
    (repTeachers.data || []).forEach(t => repTeacherMap[t.id] = `${t.first_name} ${t.last_name}`);
    const repCourseMap = {};
    (repCourses.data || []).forEach(c => repCourseMap[c.id] = `${c.grade}°${c.number}`);

    // Group replacements by absence_id
    const repByAbsence = {};
    (replacements || []).forEach(r => {
      if (!repByAbsence[r.absence_id]) repByAbsence[r.absence_id] = [];
      repByAbsence[r.absence_id].push({
        id:               r.id,
        replacement_name: repTeacherMap[r.replacement_teacher_id] || '—',
        class_hour:       r.class_hour,
        course_label:     repCourseMap[r.course_id] || null
      });
    });

    const result = absences.map(a => ({
      ...a,
      teacher_name: teacherMap[a.teacher_id] || '—',
      replacements: repByAbsence[a.id] || []
    }));

    return res.status(200).json({ absences: result });
  }

  if (req.method === 'POST') {
    const { teacher_id, date, hours_absent, reason } = req.body || {};
    if (!teacher_id || !date) return res.status(400).json({ error: 'Datos incompletos' });

    // hours_absent: null = all day, array of ints = specific hours
    const { data, error } = await sb.from('raice_teacher_absences').insert({
      teacher_id, date,
      hours_absent: hours_absent || null,
      reason: reason || null,
      registered_by: user.id
    }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });

    const { data: teacher } = await sb.from('raice_users')
      .select('first_name, last_name').eq('id', teacher_id).single();
    await logActivity(sb, user.id, 'teacher_absence',
      `Ausencia registrada: ${teacher?.first_name} ${teacher?.last_name} — ${date}${hours_absent ? ' — horas: ' + hours_absent.join(',') : ' — día completo'}`);
    return res.status(200).json({ success: true, absence: data });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // Cascade deletes replacements too (FK ON DELETE CASCADE in schema)
    await sb.from('raice_teacher_absences').delete().eq('id', id);
    await logActivity(sb, user.id, 'teacher_absence_delete', `Ausencia ${id} eliminada`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

async function handleAbsenceReplacement(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { absence_id, replacement_teacher_id, class_hour, course_id, date } = req.body || {};
    if (!absence_id || !replacement_teacher_id || !course_id)
      return res.status(400).json({ error: 'Datos incompletos' });

    // Prevent duplicate assignment for same teacher+hour
    const { data: existing } = await sb.from('raice_absence_replacements')
      .select('id').eq('absence_id', absence_id)
      .eq('replacement_teacher_id', replacement_teacher_id)
      .eq('class_hour', class_hour).limit(1);
    if (existing?.length) return res.status(400).json({ error: 'Este docente ya está asignado en esa hora' });

    const { data, error } = await sb.from('raice_absence_replacements').insert({
      absence_id, replacement_teacher_id, class_hour: class_hour || null,
      course_id, assigned_by: user.id
    }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });

    const [teacherRes, courseRes] = await Promise.all([
      sb.from('raice_users').select('first_name, last_name').eq('id', replacement_teacher_id).single(),
      sb.from('raice_courses').select('grade, number').eq('id', course_id).single()
    ]);
    const tName = teacherRes.data ? `${teacherRes.data.first_name} ${teacherRes.data.last_name}` : '—';
    const cName = courseRes.data ? `${courseRes.data.grade}°${courseRes.data.number}` : '—';
    const hLabel = class_hour ? `${class_hour}ª hora` : 'día completo';
    await logActivity(sb, user.id, 'absence_replacement',
      `Reemplazo asignado: ${tName} cubre ${cName} — ${hLabel}${date ? ' — ' + date : ''}`);
    return res.status(200).json({ success: true, replacement: data });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    await sb.from('raice_absence_replacements').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

async function getReplacementSuggestions(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  const absence_id   = url.searchParams.get('absence_id');
  const date         = url.searchParams.get('date') || todayCO();
  const hour         = parseInt(url.searchParams.get('hour') || '1');
  const include_busy = url.searchParams.get('include_busy') === '1';
  const auto_all     = url.searchParams.get('auto_all')     === '1';
  if (!absence_id) return res.status(400).json({ error: 'absence_id requerido' });

  const dayOfWeek = dayOfWeekCO(date);

  // ── Absence info ───────────────────────────────────
  const { data: absence } = await sb.from('raice_teacher_absences')
    .select('teacher_id, hours_absent').eq('id', absence_id).single();
  if (!absence) return res.status(404).json({ error: 'Ausencia no encontrada' });

  // ── FIX #1: Map absent teacher's schedule by hour ─
  // raice_schedules: teacher_course_id → raice_teacher_courses: teacher_id, course_id, subject
  const { data: absentSchedule } = await sb.from('raice_schedules')
    .select('class_hour, raice_teacher_courses!inner(teacher_id, course_id, subject, raice_courses(id, grade, number))')
    .eq('day_of_week', dayOfWeek)
    .eq('raice_teacher_courses.teacher_id', absence.teacher_id);

  // course per hour for the absent teacher (this specific day-of-week)
  const absentCourseByHour = {}; // hour → { id, grade, number, subject }
  (absentSchedule || []).forEach(row => {
    const tc = row.raice_teacher_courses;
    const c  = tc?.raice_courses;
    if (!c) return;
    if (!absentCourseByHour[row.class_hour]) absentCourseByHour[row.class_hour] = [];
    absentCourseByHour[row.class_hour].push({ id: c.id, grade: c.grade, number: c.number, subject: tc.subject });
  });

  // All courses across all hours (for reference / fallback)
  const { data: allAbsentCourses } = await sb.from('raice_teacher_courses')
    .select('course_id, subject, raice_courses(id, grade, number)')
    .eq('teacher_id', absence.teacher_id);
  const absentCoursesList = (allAbsentCourses || [])
    .map(tc => ({ id: tc.raice_courses?.id, grade: tc.raice_courses?.grade, number: tc.raice_courses?.number, subject: tc.subject }))
    .filter(c => c.id);
  const absentGrades = [...new Set(absentCoursesList.map(c => c.grade).filter(Boolean))];

  // ── FIX #5: Who is absent today (exclude from candidates) ─
  const { data: alsoAbsent } = await sb.from('raice_teacher_absences')
    .select('teacher_id, hours_absent').eq('date', date);
  const absentTodaySet = new Set(); // teacher_id → fully absent OR absent for specific hour
  (alsoAbsent || []).forEach(a => {
    if (a.teacher_id === absence.teacher_id) return; // skip the original absence
    if (a.hours_absent === null) {
      // all-day absence
      absentTodaySet.add(a.teacher_id + ':all');
    } else if (Array.isArray(a.hours_absent)) {
      a.hours_absent.forEach(h => absentTodaySet.add(a.teacher_id + ':' + h));
    }
  });
  const isAbsentForHour = (teacherId, h) =>
    absentTodaySet.has(teacherId + ':all') || absentTodaySet.has(teacherId + ':' + h);

  // ── All active teachers except absent one ──────────
  const { data: allTeachers } = await sb.from('raice_users')
    .select('id, first_name, last_name').eq('role', 'teacher').eq('active', true)
    .neq('id', absence.teacher_id);
  const teacherIds = (allTeachers || []).map(t => t.id);
  if (!teacherIds.length) return res.status(200).json({ suggestions: [], busy: [], auto_proposal: [] });

  // ── Candidate courses + grades + subjects ──────────
  const { data: candidateCourses } = await sb.from('raice_teacher_courses')
    .select('teacher_id, course_id, subject, raice_courses(id, grade, number)')
    .in('teacher_id', teacherIds);

  const teacherGradeMap   = {}; // teacher_id → Set<grade>
  const teacherSubjectMap = {}; // teacher_id → Set<subject>
  (candidateCourses || []).forEach(tc => {
    const g = tc.raice_courses?.grade;
    if (!teacherGradeMap[tc.teacher_id])   teacherGradeMap[tc.teacher_id]   = new Set();
    if (!teacherSubjectMap[tc.teacher_id]) teacherSubjectMap[tc.teacher_id] = new Set();
    if (g) teacherGradeMap[tc.teacher_id].add(g);
    if (tc.subject) teacherSubjectMap[tc.teacher_id].add(tc.subject.toLowerCase());
  });

  // ── FIX #4: Weekly replacement count (not just today) ─
  const weekStart = (() => {
    const d = new Date(date + 'T12:00:00');
    const day = d.getDay() || 7; // 1=Mon
    d.setDate(d.getDate() - day + 1);
    return d.toISOString().slice(0, 10);
  })();
  const { data: weekReps } = await sb
    .from('raice_absence_replacements')
    .select('replacement_teacher_id, raice_teacher_absences!inner(date)')
    .gte('raice_teacher_absences.date', weekStart)
    .lte('raice_teacher_absences.date', date);
  const weekRepCount = {}; // teacher_id → count this week
  (weekReps || []).forEach(r => {
    weekRepCount[r.replacement_teacher_id] = (weekRepCount[r.replacement_teacher_id] || 0) + 1;
  });

  // Today count (still useful for display)
  const { data: todayReps } = await sb
    .from('raice_absence_replacements')
    .select('replacement_teacher_id, raice_teacher_absences!inner(date)')
    .eq('raice_teacher_absences.date', date);
  const todayRepCount = {};
  (todayReps || []).forEach(r => {
    todayRepCount[r.replacement_teacher_id] = (todayRepCount[r.replacement_teacher_id] || 0) + 1;
  });

  // ── Core: build suggestions for one hour ───────────
  async function suggestionsForHour(h) {
    // FIX #1: courses the absent teacher actually has THIS hour
    const coursesThisHour = absentCourseByHour[h] || absentCoursesList; // fallback to all if no schedule

    // Who has scheduled class this hour (their own)
    const { data: busyRows } = await sb.from('raice_schedules')
      .select('raice_teacher_courses(teacher_id)')
      .eq('day_of_week', dayOfWeek).eq('class_hour', h);
    const busyTeacherIds = new Set(
      (busyRows || []).map(r => r.raice_teacher_courses?.teacher_id).filter(Boolean)
    );

    // Who is already assigned as replacement this specific hour today
    const { data: alreadyReplacing } = await sb
      .from('raice_absence_replacements')
      .select('replacement_teacher_id, raice_teacher_absences!inner(date)')
      .eq('class_hour', h)
      .eq('raice_teacher_absences.date', date);
    const alreadyReplacingIds = new Set(
      (alreadyReplacing || []).map(r => r.replacement_teacher_id)
    );

    const buildCandidates = (teachers, isBusy) => teachers.map(t => {
      const myGrades   = teacherGradeMap[t.id]   || new Set();
      const mySubjects = teacherSubjectMap[t.id] || new Set();

      // FIX #1: only offer courses the absent teacher actually has this hour
      const matchedCourses = coursesThisHour.map(c => ({
        ...c,
        affinity: myGrades.has(c.grade)
          ? (c.subject && mySubjects.has((c.subject || '').toLowerCase()) ? 'same_subject' : 'same_grade')
          : 'outside'
      })).sort((a, b) => {
        const rank = { same_subject: 0, same_grade: 1, outside: 2 };
        return rank[a.affinity] - rank[b.affinity];
      });

      const bestAffinity = matchedCourses[0]?.affinity || 'outside';
      const teaches_grade = myGrades.size > 0 && absentGrades.some(g => myGrades.has(g));

      // FIX #4: composite score (lower = better)
      // 0=same_subject, 1=same_grade, 2=outside  ×10 + weekRepCount (load balancing)
      const affinityScore = { same_subject: 0, same_grade: 10, outside: 20 }[bestAffinity] || 20;
      const score = affinityScore + (weekRepCount[t.id] || 0);

      return {
        teacher_id:          t.id,
        teacher_name:        `${t.first_name} ${t.last_name}`,
        teaches_grade,
        best_affinity:       bestAffinity,
        replacements_today:  todayRepCount[t.id]  || 0,
        replacements_week:   weekRepCount[t.id]   || 0,
        score,                // FIX #4: expose score for frontend
        is_busy:             isBusy,
        absent_courses:      matchedCourses
      };
    });

    // FIX #5: exclude teachers absent for this specific hour
    const free = (allTeachers || []).filter(t =>
      !busyTeacherIds.has(t.id) &&
      !alreadyReplacingIds.has(t.id) &&
      !isAbsentForHour(t.id, h)          // FIX #5
    );
    const busy = (allTeachers || []).filter(t =>
      (busyTeacherIds.has(t.id) || alreadyReplacingIds.has(t.id)) &&
      !isAbsentForHour(t.id, h)
    );

    const freeCandidates = buildCandidates(free, false).sort((a, b) => a.score - b.score);
    const busyCandidates = buildCandidates(busy, true).sort((a, b) => a.score - b.score);

    return { free: freeCandidates, busy: busyCandidates, courses_this_hour: coursesThisHour };
  }

  // ── FIX #3: AUTO-PROPOSAL with real bell schedule ──
  if (auto_all) {
    let hours;
    if (absence.hours_absent === null) {
      // Full-day absence: get bell schedule hours for this day
      const { data: bellRows } = await sb.from('raice_bell_schedule')
        .select('class_hour').order('class_hour');
      if (bellRows?.length) {
        hours = bellRows.map(b => b.class_hour);
      } else {
        // Fallback: only hours where the absent teacher actually has class today
        const scheduledHours = Object.keys(absentCourseByHour).map(Number).sort((a,b)=>a-b);
        // Last resort: use classes_per_day from config, or 6
        const { data: cfgFb } = await sb.from('raice_config').select('classes_per_day').eq('id',1).maybeSingle().catch(()=>({data:null}));
        const maxH = cfgFb?.classes_per_day || 6;
        hours = scheduledHours.length ? scheduledHours : Array.from({length:maxH},(_,i)=>i+1);
      }
    } else {
      hours = absence.hours_absent;
    }

    // Only propose hours where absent teacher actually has a course
    const hoursWithClass = hours.filter(h => (absentCourseByHour[h] || []).length > 0);
    const hoursToPropose = hoursWithClass.length > 0 ? hoursWithClass : hours;

    const proposal = [];
    for (const h of hoursToPropose) {
      const { free, courses_this_hour } = await suggestionsForHour(h);
      const best       = free[0] || null;
      const bestCourse = best?.absent_courses?.[0] || courses_this_hour?.[0] || null;
      proposal.push({
        class_hour:       h,
        teacher_id:       best?.teacher_id    || null,
        teacher_name:     best?.teacher_name  || null,
        best_affinity:    best?.best_affinity || null,
        replacements_week: best?.replacements_week || 0,
        score:            best?.score         ?? null,
        course_id:        bestCourse?.id      || null,
        course_label:     bestCourse ? `${bestCourse.grade}°${bestCourse.number}` : null,
        subject:          bestCourse?.subject || null,
        covered:          !!best
      });
    }
    return res.status(200).json({ auto_proposal: proposal, absent_courses: absentCoursesList });
  }

  // ── SINGLE HOUR suggestions ────────────────────────
  const { free, busy, courses_this_hour } = await suggestionsForHour(hour);
  return res.status(200).json({
    suggestions:    free,
    busy:           include_busy ? busy : [],
    has_busy:       busy.length > 0,
    absent_courses: courses_this_hour,     // FIX #1: only courses for this hour
    all_courses:    absentCoursesList
  });
}

async function getEvasions(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date       = url.searchParams.get('date');
  const from       = url.searchParams.get('from');
  const to         = url.searchParams.get('to');
  const student_id = url.searchParams.get('student_id');

  let rangeStart, rangeEnd;

  if (from && to) {
    // Full range: from Colombia midnight to end of `to` day
    const nextDay = (() => {
      const d = new Date(to + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();
    rangeStart = from + 'T05:00:00.000Z';
    rangeEnd   = nextDay + 'T05:00:00.000Z';
  } else {
    const target = date || todayCO();
    const nextDay = (() => {
      const d = new Date(target + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();
    rangeStart = target  + 'T05:00:00.000Z';
    rangeEnd   = nextDay + 'T05:00:00.000Z';
  }

  let query = sb.from('raice_notifications')
    .select('id, title, body, read, created_at, link_id, from_user_id, type')
    .eq('to_user_id', user.id)
    .in('type', ['evasion', 'evasion_confirmed', 'evasion_dismissed', 'evasion_retracted'])
    .gte('created_at', rangeStart)
    .lt('created_at', rangeEnd)
    .order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Error al cargar evasiones' });

  // Enriquecer con nombre del docente que reportó
  const fromIds = [...new Set((data || []).map(n => n.from_user_id).filter(Boolean))];
  const fromMap = {};
  if (fromIds.length > 0) {
    const { data: teachers } = await sb.from('raice_users')
      .select('id, first_name, last_name').in('id', fromIds);
    (teachers || []).forEach(t => fromMap[t.id] = `${t.first_name} ${t.last_name}`);
  }

  // link_id stores the student_id directly — fetch student info from raice_students
  const studentIds = [...new Set((data || []).map(n => n.link_id).filter(Boolean))];
  const studentInfoMap = {};
  if (studentIds.length > 0) {
    const { data: stuRows } = await sb.from('raice_students')
      .select('id, first_name, last_name, grade, course')
      .in('id', studentIds);
    (stuRows || []).forEach(s => {
      studentInfoMap[s.id] = {
        student_id:   s.id,
        student_name: `${s.first_name} ${s.last_name}`,
        grade:        s.grade,
        course:       s.course
      };
    });
  }

  const evasions = (data || []).map(n => {
    const stuInfo = studentInfoMap[n.link_id] || {};
    // Fallback: parse student name from notification title "🚨 Posible evasión — Nombre"
    const nameFromTitle = !stuInfo.student_name && n.title
      ? (n.title.split('—')[1] || '').trim() || '—'
      : null;
    return {
      ...n,
      reported_by:  fromMap[n.from_user_id] || '—',
      teacher_name: fromMap[n.from_user_id] || '—',
      student_id:   stuInfo.student_id   || n.link_id  || null,
      student_name: stuInfo.student_name || nameFromTitle || '—',
      grade:        stuInfo.grade        || null,
      course:       stuInfo.course       || null,
      date: n.created_at ? n.created_at.slice(0,10) : (date || todayCO())
    };
  });

  // Filter by student_id if requested
  const filtered = student_id
    ? evasions.filter(e => e.student_id === student_id)
    : evasions;

  return res.status(200).json({ evasions: filtered, date: date || from || todayCO() });
}

// =====================================================
// RESOLVER EVASIÓN (confirmar / descartar)
// =====================================================
async function resolveEvasion(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();

  const { notification_id, student_id, action, case_type, description } = req.body || {};
  // action: 'confirm' | 'dismiss'
  if (!notification_id || !action) return res.status(400).json({ error: 'Datos incompletos' });

  // Mark all evasion notifications for this student+date as resolved by updating read=true
  // and adding a metadata marker via a second update (we store resolution in the read flag
  // and mark with type = 'evasion_confirmed' or 'evasion_dismissed')
  const { data: notif } = await sb.from('raice_notifications')
    .select('id, link_id, body, to_user_id, created_at')
    .eq('id', notification_id).single();
  if (!notif) return res.status(404).json({ error: 'Notificación no encontrada' });

  const resolvedType = action === 'confirm' ? 'evasion_confirmed' : 'evasion_dismissed';

  // Update this notification's type to record resolution, mark read
  await sb.from('raice_notifications')
    .update({ type: resolvedType, read: true })
    .eq('id', notification_id);

  // Also mark any duplicate evasion notifications for the same student on the same date
  if (student_id) {
    const dateStr = notif.created_at.slice(0, 10);
    const nextDay = (() => {
      const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    await sb.from('raice_notifications')
      .update({ type: resolvedType, read: true })
      .eq('type', 'evasion')
      .eq('link_id', student_id)
      .gte('created_at', dateStr + 'T00:00:00.000Z')
      .lt('created_at',  nextDay  + 'T00:00:00.000Z');
  }

  if (action === 'dismiss') {
    await logActivity(sb, user.id, 'evasion_dismissed', `Evasión descartada para estudiante ${student_id}`);
    return res.status(200).json({ success: true, action: 'dismissed' });
  }

  // ── CONFIRM: create RAICE case ──
  const sid = student_id || notif.link_id;
  if (!sid) return res.status(400).json({ error: 'No se puede identificar al estudiante' });

  const { data: student } = await sb.from('raice_students')
    .select('first_name, last_name, grade, course, course_id').eq('id', sid).single();
  if (!student) return res.status(404).json({ error: 'Estudiante no encontrado' });

  const caseDesc = description?.trim() ||
    `Evasión confirmada. ${notif.body || ''}`.trim();
  const ctype = parseInt(case_type) || 1;

  const { data: caseData, error: caseErr } = await sb.from('raice_cases').insert({
    student_id:   sid,
    course_id:    student.course_id || null,
    student_name: `${student.first_name} ${student.last_name}`,
    grade:        student.grade,
    course:       student.course,
    teacher_id:   user.id,
    type:         ctype,
    description:  caseDesc,
    status:       'open'
  }).select().single();

  if (caseErr) return res.status(500).json({ error: 'Error al crear el caso: ' + caseErr.message });

  await logActivity(sb, user.id, 'evasion_confirmed',
    `Evasión confirmada → Caso Tipo ${ctype} para ${student.first_name} ${student.last_name}`);

  return res.status(200).json({ success: true, action: 'confirmed', case: caseData });
}
async function handleClassroomRemovals(req, res, user) {
  const sb = getSupabase();

  // POST: docente registra un retiro
  if (req.method === 'POST') {
    if (!['teacher','admin'].includes(user.role))
      return res.status(403).json({ error: 'Sin permiso' });

    const { student_id, course_id, date, class_hour, reason } = req.body || {};
    if (!student_id || !course_id || !reason?.trim())
      return res.status(400).json({ error: 'Faltan campos requeridos' });

    const { data, error } = await sb.from('raice_classroom_removals').insert({
      student_id, course_id, date: date || todayCO(),
      class_hour: class_hour || null,
      reason: reason.trim(),
      teacher_id: user.id
    }).select().single();

    if (error) return res.status(500).json({ error: _dbErr(error) });

    // Obtener nombre del estudiante y del docente para la notificación
    const [{ data: stu }, { data: tch }] = await Promise.all([
      sb.from('raice_students').select('first_name,last_name,grade,course').eq('id', student_id).single(),
      sb.from('raice_users').select('first_name,last_name').eq('id', user.id).single()
    ]);
    const stuName = stu ? `${stu.first_name} ${stu.last_name}` : 'Estudiante';
    const tchName = tch ? `${tch.first_name} ${tch.last_name}` : 'Docente';

    // Notificar a todos los coordinadores
    const { data: coords } = await sb.from('raice_users')
      .select('id').eq('role', 'admin').eq('school_id', user.school_id);
    if (coords?.length) {
      await sb.from('raice_notifications').insert(
        coords.map(c => ({
          to_user_id:   c.id,
          from_user_id: user.id,
          type: 'classroom_removal',
          title: `⛔ Retiro de clase — ${stuName}`,
          body:  `${tchName} retiró a ${stuName} de clase${class_hour ? ` (${class_hour}ª hora)` : ''}. Motivo: ${reason.trim()}`,
          link_id: data.id
        }))
      );
    }

    return res.status(201).json({ removal: data });
  }

  // GET: coordinador ve los retiros (por fecha exacta, por rango from/to, o por estudiante)
  if (req.method === 'GET') {
    if (!['admin','superadmin'].includes(user.role))
      return res.status(403).json({ error: 'Sin permiso' });

    const { date, from, to, student_id } = req.query || {};

    let query = sb.from('raice_classroom_removals')
      .select(`*, raice_students(first_name,last_name,grade,course),
               raice_users!raice_classroom_removals_teacher_id_fkey(first_name,last_name),
               raice_courses(grade,number)`)
      .order('created_at', { ascending: false });

    if (student_id) {
      query = query.eq('student_id', student_id);
      if (from) query = query.gte('date', from);
      if (to)   query = query.lte('date', to);
    } else if (from && to) {
      query = query.gte('date', from).lte('date', to);
    } else {
      query = query.eq('date', date || todayCO());
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ removals: data || [] });
  }

  // PATCH: coordinador marca como revisado
  if (req.method === 'PATCH') {
    if (!['admin','superadmin'].includes(user.role))
      return res.status(403).json({ error: 'Sin permiso' });
    const { id, status } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id' });
    const { error } = await sb.from('raice_classroom_removals')
      .update({ status: status || 'reviewed', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// =====================================================
// FASE 4 — SUSPENSIONES
// =====================================================
async function handleSuspensions(req, res, user) {
  const sb = getSupabase();

  // POST: coordinador registra suspensión
  if (req.method === 'POST') {
    if (user.role !== 'admin')
      return res.status(403).json({ error: 'Solo coordinadores pueden registrar suspensiones' });

    const { student_id, start_date, end_date, reason, case_id } = req.body || {};
    if (!student_id || !start_date || !end_date || !reason?.trim())
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    if (new Date(end_date) < new Date(start_date))
      return res.status(400).json({ error: 'La fecha de fin debe ser igual o posterior al inicio' });

    const { data, error } = await sb.from('raice_suspensions').insert({
      student_id, start_date, end_date,
      reason: reason.trim(),
      case_id: case_id || null,
      coordinator_id: user.id
    }).select().single();

    if (error) return res.status(500).json({ error: _dbErr(error) });

    // Auto-ausencias por suspensión en todas las clases/horas
    try {
      const { data: student } = await sb.from('raice_students')
        .select('course_id').eq('id', student_id).maybeSingle();
      if (student?.course_id) {
        const { data: tcRows } = await sb.from('raice_teacher_courses')
          .select('id').eq('course_id', student.course_id);
        const tcIds = (tcRows || []).map(r => r.id);
        if (tcIds.length) {
          const { data: schedRows } = await sb.from('raice_schedules')
            .select('day_of_week, class_hour')
            .in('teacher_course_id', tcIds);

          if (schedRows?.length) {
            const attendanceRows = [];
            let curr = new Date(start_date + 'T12:00:00');
            const end = new Date(end_date + 'T12:00:00');
            while (curr <= end) {
              const dayNum = curr.getDay(); // 1=Mon ... 5=Fri
              if (dayNum >= 1 && dayNum <= 5) {
                const dateStr = curr.toISOString().slice(0, 10);
                const daySched = (schedRows || []).filter(s => s.day_of_week === dayNum);
                daySched.forEach(s => {
                  attendanceRows.push({
                    student_id,
                    course_id: student.course_id,
                    date: dateStr,
                    class_hour: s.class_hour,
                    status: 'A',
                    teacher_id: null
                  });
                });
              }
              curr.setDate(curr.getDate() + 1);
            }

            if (attendanceRows.length) {
              await sb.from('raice_attendance').upsert(attendanceRows, {
                onConflict: 'student_id,date,course_id,class_hour'
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Error al registrar auto-ausencias de la suspensión:', e);
    }

    return res.status(201).json({ suspension: data });
  }

  // GET: activas hoy, por rango de fechas o por estudiante
  if (req.method === 'GET') {
    const { student_id, active_only, from, to } = req.query || {};
    let query = sb.from('raice_suspensions')
      .select('*, raice_students(first_name,last_name,grade,course), raice_users(first_name,last_name)')
      .order('start_date', { ascending: false });

    if (student_id) {
      query = query.eq('student_id', student_id);
      if (from) query = query.gte('start_date', from);
      if (to)   query = query.lte('start_date', to);
    } else if (from && to) {
      // Overlapping suspensions within range
      query = query.lte('start_date', to).gte('end_date', from);
    } else if (active_only !== 'false') {
      const today = todayCO();
      query = query.lte('start_date', today).gte('end_date', today);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ suspensions: data || [] });
  }

  // DELETE: cancelar suspensión
  if (req.method === 'DELETE') {
    if (user.role !== 'admin')
      return res.status(403).json({ error: 'Sin permiso' });
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'Falta id' });

    // Obtener datos antes de borrar para saber a quién y qué fechas limpiar
    const { data: suspension } = await sb.from('raice_suspensions')
      .select('student_id, start_date, end_date')
      .eq('id', id).maybeSingle();

    const { error } = await sb.from('raice_suspensions').delete().eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });

    // Limpiar ausencias automáticas de la suspensión si existen
    if (suspension) {
      try {
        await sb.from('raice_attendance')
          .delete()
          .eq('student_id', suspension.student_id)
          .gte('date', suspension.start_date)
          .lte('date', suspension.end_date)
          .is('teacher_id', null); // Solo borrar si son las del sistema sin docente asignado
      } catch (_) {}
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// =====================================================
// FASE 4 — DESBLOQUEO DE ASISTENCIA (docente corrige)
// =====================================================
async function unlockAttendance(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (user.role !== 'teacher') return res.status(403).json({ error: 'Solo docentes pueden solicitar corrección' });

  const sb = getSupabase();
  const { course_id, date, class_hour, reason } = req.body || {};
  if (!course_id || !date || !class_hour || !reason?.trim())
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  // ── Correction window validation ─────────────────────────
  let config = null;
  try {
    const { data: cfgData } = await sb.from('raice_config').select(
      'correction_window, correction_window_minutes, correction_window_hour'
    ).eq('id', 1).maybeSingle();
    config = cfgData;
  } catch (_) { /* columns not yet migrated — skip validation */ }

  const window_type    = config?.correction_window         || 'same_day_end';
  const window_minutes = config?.correction_window_minutes || 55;
  const window_hour    = config?.correction_window_hour    || '23:59';

  // Current time in Colombia (UTC-5)
  const nowCO = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const todayDateCO = nowCO.toISOString().slice(0, 10);

  // Build the deadline based on config
  let deadline = null;
  let windowLabel = '';

  if (window_type === 'class_duration') {
    // Find when this class hour was first saved and add window_minutes
    const { data: firstRecord } = await sb.from('raice_attendance')
      .select('created_at').eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (firstRecord?.created_at) {
      deadline = new Date(new Date(firstRecord.created_at).getTime() + window_minutes * 60 * 1000);
      windowLabel = `${window_minutes} minutos desde que se tomó la lista`;
    } else {
      // No record found — allow (list might not be saved yet)
      deadline = null;
    }
  } else if (window_type === 'same_day_hour') {
    // Same day up to a specific hour (e.g. "15:30")
    const [hh, mm] = (window_hour || '17:00').split(':').map(Number);
    deadline = new Date(`${date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
    // Convert the stored hour to UTC (Colombia is UTC-5, so stored local time + 5h = UTC)
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = `hasta las ${window_hour} del día de la lista`;
  } else if (window_type === 'same_day_end') {
    // Same day until 23:59:59 Colombia time
    deadline = new Date(`${date}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000); // to UTC
    windowLabel = 'hasta las 11:59 PM del día de la lista';
  } else if (window_type === 'next_day_end') {
    // Day after the list until 23:59:59 Colombia time
    const nextDay = (() => {
      const d = new Date(date + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    deadline = new Date(`${nextDay}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = 'hasta las 11:59 PM del día siguiente';
  }

  const nowUTC = new Date();
  if (deadline && nowUTC > deadline) {
    return res.status(403).json({
      error: `La ventana de corrección ya cerró (${windowLabel}). Solicita al coordinador que haga la corrección.`,
      window_closed: true
    });
  }

  // ── Access check ──────────────────────────────────────────
  const { data: tcRows } = await sb.from('raice_teacher_courses')
    .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);

  if (!tcRows?.length)
    return res.status(403).json({ error: 'No tienes acceso a este curso' });

  // Audit trail
  try {
    await sb.from('raice_attendance').update({
      corrected_by: user.id,
      corrected_at: new Date().toISOString(),
      correction_reason: reason.trim()
    }).eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour);
  } catch (_) {}

  await logActivity(sb, user.id, 'attendance_unlock',
    `Desbloqueó lista ${date} hora ${class_hour} curso ${course_id} — Motivo: ${reason.trim()}`);

  return res.status(200).json({ ok: true });
}

// =====================================================
// REPORTE ASISTENCIA V2 — 3 niveles
// =====================================================
async function reportAttendanceV2(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  const date_from  = url.searchParams.get('from')       || todayCO();
  const date_to    = url.searchParams.get('to')         || date_from;
  const level      = url.searchParams.get('level')      || 'executive'; // executive | course | student
  const course_id  = url.searchParams.get('course_id')  || null;
  const student_id = url.searchParams.get('student_id') || null;
  const grade_req  = url.searchParams.get('grade')      || null;
  const course_req = url.searchParams.get('course')     || null; // course number (1, 2, 3...)

  // ── Step 1: Identify the target roster (Student-First) ──
  let studentQuery = sb.from('raice_students')
    .select('id, first_name, last_name, grade, course, course_id')
    .eq('status', 'active');

  if (student_id) studentQuery = studentQuery.eq('id', student_id);
  else if (course_id) studentQuery = studentQuery.eq('course_id', course_id);
  else {
    if (grade_req)  studentQuery = studentQuery.eq('grade', grade_req);
    if (course_req) studentQuery = studentQuery.eq('course', course_req);
  }

  const { data: roster, error: rErr } = await studentQuery.limit(5000);
  if (rErr) return res.status(500).json({ error: 'Error al cargar listado de estudiantes' });
  const students = roster || [];
  const targetSids = students.map(s => s.id);

  // ── Step 2: Fetch attendance for these students ──────
  let attData = [];
  if (targetSids.length) {
    let attQuery = sb.from('raice_attendance')
      .select('student_id, date, status, class_hour, course_id')
      .gte('date', date_from).lte('date', date_to);

    // Only filter by specific IDs if we are not in "All" mode
    // (To avoid massive URL payloads when fetching the whole school)
    const isFiltered = student_id || course_id || grade_req || course_req;
    if (isFiltered) {
      attQuery = attQuery.in('student_id', targetSids);
    }

    const { data, error: attErr } = await attQuery.order('date').order('student_id').limit(15000);
    if (attErr) return res.status(500).json({ error: attErr.message });
    attData = data || [];
  }

  // Pre-fetch courses for labeling if not joined
  const cIds = [...new Set(attData.map(r => r.course_id).filter(Boolean))];
  const { data: cRes } = cIds.length 
    ? await sb.from('raice_courses').select('id,grade,number').in('id', cIds)
    : { data: [] };
  const cMap = {};
  (cRes||[]).forEach(c => cMap[c.id] = c);

  // ── Step 3: Initialize statistics for everyone ────────
  const studentStats = {}; 
  students.forEach(s => {
    studentStats[s.id] = {
      id:         s.id,
      name:       `${s.last_name}, ${s.first_name}`,
      first_name: s.first_name,
      last_name:  s.last_name,
      grade:      s.grade,
      course:     s.course,
      total: 0, P: 0, A: 0, T: 0, PE: 0,
      byWeek: {}, byDate: {}
    };
  });

  // ── Step 4: Aggregate attendance data ────────────────
  attData.forEach(r => {
    const st = studentStats[r.student_id];
    if (!st) return; // Should not happen with current logic
    
    st.total++;
    st[r.status] = (st[r.status] || 0) + 1;
    // by date
    if (!st.byDate[r.date]) st.byDate[r.date] = { P:0, A:0, T:0, PE:0 };
    st.byDate[r.date][r.status]++;
    // by ISO week
    const week = isoWeek(r.date);
    if (!st.byWeek[week]) st.byWeek[week] = { P:0, A:0, T:0, PE:0 };
    st.byWeek[week][r.status]++;
  });

  // Add derived fields
  Object.values(studentStats).forEach(st => {
    st.pct_attendance = st.total > 0 ? Math.round((st.P / st.total) * 100) : null;
    st.alert = st.pct_attendance !== null && st.pct_attendance < 75;
    st.warning = st.pct_attendance !== null && st.pct_attendance >= 75 && st.pct_attendance < 85;
  });

  // ── LEVEL: STUDENT ────────────────────────────────────
  if (level === 'student') {
    const st = student_id ? studentStats[student_id] : null;
    return res.status(200).json({
      level: 'student',
      date_from, date_to,
      student: st || null,
      rows: st ? buildStudentRows(st, attData.filter(r => r.student_id === student_id)) : []
    });
  }

  // ── LEVEL: COURSE ─────────────────────────────────────
  if (level === 'course') {
    // Per course aggregation
    const courseStats = {};
    Object.values(studentStats).forEach(st => {
      const key = `${st.grade}-${st.course}`;
      if (!courseStats[key]) courseStats[key] = { grade: st.grade, course: st.course, students: [], total:0, P:0, A:0, T:0, PE:0 };
      courseStats[key].students.push(st);
      courseStats[key].total += st.total;
      courseStats[key].P     += st.P;
      courseStats[key].A     += st.A;
      courseStats[key].T     += st.T;
      courseStats[key].PE    += st.PE;
    });
    Object.values(courseStats).forEach(c => {
      c.pct_attendance = c.total > 0 ? Math.round((c.P / c.total) * 100) : null;
      c.students.sort((a,b) => (a.last_name||'').localeCompare(b.last_name||'') || (a.first_name||'').localeCompare(b.first_name||''));
    });
    const courses = Object.values(courseStats).sort((a,b) => a.grade - b.grade || String(a.course).localeCompare(String(b.course)));
    return res.status(200).json({ level: 'course', date_from, date_to, courses });
  }

  // ── LEVEL: EXECUTIVE ─────────────────────────────────
  const allStudents = Object.values(studentStats).sort((a,b) => a.grade - b.grade || String(a.course).localeCompare(String(b.course)) || (a.last_name||'').localeCompare(b.last_name||''));
  const total   = attData.length;
  const present = attData.filter(r => r.status === 'P' || r.status === 'PE').length;
  const absent  = attData.filter(r => r.status === 'A').length;
  const late    = attData.filter(r => r.status === 'T').length;
  const permit  = attData.filter(r => r.status === 'PE').length;

  // Top 10 most absent
  const topAbsent = [...allStudents].sort((a,b) => b.A - a.A).slice(0, 10);
  // Students below threshold
  const atRisk = allStudents.filter(s => s.alert).sort((a,b) => a.pct_attendance - b.pct_attendance);
  // By week trend
  const weekTrend = {};
  attData.forEach(r => {
    const w = isoWeek(r.date);
    if (!weekTrend[w]) weekTrend[w] = { total:0, P:0 };
    weekTrend[w].total++;
    if (r.status === 'P' || r.status === 'PE') weekTrend[w].P++;
  });
  const trend = Object.entries(weekTrend).sort(([a],[b]) => a.localeCompare(b))
    .map(([week, d]) => ({ week, pct: d.total ? Math.round(d.P/d.total*100) : 0 }));

  return res.status(200).json({
    level: 'executive',
    date_from, date_to,
    summary: { total, present, absent, late, permit,
      pct_attendance: total > 0 ? Math.round(present/total*100) : null,
      total_students: allStudents.length,
      at_risk_count: atRisk.length
    },
    top_absent: topAbsent,
    at_risk: atRisk,
    week_trend: trend,
    all_students: allStudents
  });
}

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

function buildStudentRows(st, attRows) {
  return attRows.map(r => ({
    date: r.date,
    class_hour: r.class_hour,
    status: r.status
  })).sort((a,b) => a.date.localeCompare(b.date) || a.class_hour - b.class_hour);
}

// ---- FALTAS CATÁLOGO ----
async function handleFaltasCatalogo(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const tipo     = url.searchParams.get('tipo');
    const soloActivas = url.searchParams.get('activas') !== 'false';
    let q = sb.from('raice_faltas_catalogo').select('*').order('tipo').order('categoria').order('orden');
    if (tipo)        q = q.eq('tipo', parseInt(tipo));
    if (soloActivas) q = q.eq('activa', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Error al cargar catálogo' });
    // Sort by numeric parts of numeral (e.g. "1.10" > "1.9") since DB stores as text
    const sorted = (data || []).sort((a, b) => {
      if (a.tipo !== b.tipo) return a.tipo - b.tipo;
      if (a.categoria !== b.categoria) return a.categoria.localeCompare(b.categoria);
      const [aM, am] = a.numeral.split('.').map(Number);
      const [bM, bm] = b.numeral.split('.').map(Number);
      return aM !== bM ? aM - bM : (am || 0) - (bm || 0);
    });
    // Deduplicate by tipo+categoria+numeral (keep first occurrence / lowest id)
    const seen = new Set();
    const unique = sorted.filter(f => {
      const key = `${f.tipo}-${f.categoria}-${f.numeral}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return res.status(200).json({ faltas: unique });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin');
    const { tipo, categoria, numeral, descripcion, orden } = req.body || {};
    if (!tipo || !categoria || !numeral || !descripcion)
      return res.status(400).json({ error: 'Datos incompletos' });
    const { data, error } = await sb.from('raice_faltas_catalogo')
      .insert({ tipo, categoria, numeral, descripcion, orden: orden || 0 }).select().single();
    if (error) return res.status(500).json({ error: 'Error al crear falta' });
    return res.status(200).json({ success: true, falta: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin');
    const { id, descripcion, activa, orden } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (descripcion !== undefined) updates.descripcion = descripcion;
    if (activa      !== undefined) updates.activa      = activa;
    if (orden       !== undefined) updates.orden       = orden;
    const { error } = await sb.from('raice_faltas_catalogo').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al actualizar falta' });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // Check if this falta is referenced in any case before deleting
    const { count } = await sb.from('raice_cases')
      .select('id', { count: 'exact', head: true }).eq('falta_id', id);
    if (count > 0) {
      return res.status(409).json({
        error: `Esta falta está referenciada en ${count} caso(s). Desactívala en lugar de eliminarla.`
      });
    }
    const { error } = await sb.from('raice_faltas_catalogo').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar falta' });
    await logActivity(sb, user.id, 'delete_falta', `Falta eliminada: ${id}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// =====================================================
// =====================================================
// CLEANUP ORPHANED PE — Admin/Superadmin only
// PE attendance records that have no matching raice_excusas row
// =====================================================
async function cleanupOrphanedPE(req, res, user) {
  requireRole(user, 'admin', 'superadmin');
  const sb = getSupabase();

  // Fetch all PE attendance records
  const { data: peRows, error: peErr } = await sb
    .from('raice_attendance')
    .select('id, student_id, date, class_hour, course_id')
    .eq('status', 'PE');
  if (peErr) return res.status(500).json({ error: _dbErr(peErr) });
  if (!peRows || !peRows.length) return res.status(200).json({ orphaned: 0, deleted: 0 });

  // Fetch all excusas (only student_id + date needed)
  const { data: excusas, error: excErr } = await sb
    .from('raice_excusas')
    .select('student_id, date, horas');
  if (excErr) return res.status(500).json({ error: _dbErr(excErr) });

  // Build a Set of "student_id|date" keys that ARE covered by an excusa
  // For excusas with specific hours, build "student_id|date|class_hour" keys
  const coveredKeys  = new Set();   // student_id|date  (all-hours excusas)
  const coveredHrKeys = new Set();  // student_id|date|class_hour (specific-hour excusas)
  (excusas || []).forEach(e => {
    if (!e.horas || !e.horas.length) {
      coveredKeys.add(`${e.student_id}|${e.date}`);
    } else {
      e.horas.forEach(h => coveredHrKeys.add(`${e.student_id}|${e.date}|${h}`));
    }
  });

  // Identify orphaned PE rows
  const orphanedIds = peRows
    .filter(r => {
      const dayKey = `${r.student_id}|${r.date}`;
      const hrKey  = `${r.student_id}|${r.date}|${r.class_hour}`;
      return !coveredKeys.has(dayKey) && !coveredHrKeys.has(hrKey);
    })
    .map(r => r.id);

  if (req.method === 'GET') {
    // Preview only — return count without deleting
    return res.status(200).json({ orphaned: orphanedIds.length });
  }

  if (req.method === 'DELETE') {
    if (!orphanedIds.length) return res.status(200).json({ deleted: 0 });

    // Delete in batches of 100 to stay within Supabase limits
    let deleted = 0;
    for (let i = 0; i < orphanedIds.length; i += 100) {
      const batch = orphanedIds.slice(i, i + 100);
      const { error } = await sb.from('raice_attendance').delete().in('id', batch);
      if (error) return res.status(500).json({ error: _dbErr(error), deleted });
      deleted += batch.length;
    }

    await logActivity(sb, user.id, 'cleanup',
      `Limpieza PE huérfanos: ${deleted} registros eliminados`);
    return res.status(200).json({ deleted });
  }

  return res.status(405).end();
}

// =====================================================
// EXCUSAS — Director de grado
// =====================================================
async function handleExcusas(req, res, user) {
  requireRole(user, 'teacher', 'admin', 'superadmin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    // Admin can query all students (no course_id required)
    const course_id  = url.searchParams.get('course_id');
    const date       = url.searchParams.get('date');
    const student_id = url.searchParams.get('student_id');

    let query = sb.from('raice_excusas')
      .select('id, student_id, course_id, date, motivo, horas, registered_by, created_at, raice_students(first_name, last_name, grade, course), raice_users(first_name, last_name)');

    if (course_id) query = query.eq('course_id', course_id);
    if (date)      query = query.eq('date', date);
    if (student_id) query = query.eq('student_id', student_id);

    if (!course_id && !student_id && !date) {
      // Admin listing all: limit to last 10000 to prevent client-side filter truncation
      const limit = Math.min(10000, Math.max(1, parseInt(url.searchParams.get('limit') || '10000')));
      query = query.order('created_at', { ascending: false }).limit(limit);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ excusas: data || [] });
  }

  if (req.method === 'POST') {
    const { student_id, course_id, date, motivo, horas, end_date, no_weekends } = req.body || {};
    if (!student_id || !date || !motivo)
      return res.status(400).json({ error: 'Faltan campos requeridos (student_id, date, motivo)' });

    // Generate date range
    const datesToProcess = [];
    if (end_date) {
      if (end_date < date) return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la de inicio' });
      let current = new Date(date + 'T12:00:00Z');
      const end = new Date(end_date + 'T12:00:00Z');
      while (current <= end) {
        datesToProcess.push(current.toISOString().slice(0,10));
        current.setDate(current.getDate() + 1);
      }
    } else {
      datesToProcess.push(date);
    }

    // Load active periods and calendar holidays for bulk check
    const { data: periods } = await sb.from('raice_periods')
      .select('start_date, end_date, name')
      .eq('active', true).limit(1).maybeSingle();
    
    let holidaysSet = new Set();
    if (datesToProcess.length > 0) {
      const { data: holidays } = await sb.from('raice_calendar')
        .select('date, name')
        .eq('type', 'holiday')
        .gte('date', datesToProcess[0])
        .lte('date', datesToProcess[datesToProcess.length - 1]);
      (holidays || []).forEach(h => holidaysSet.add(h.date));
    }

    // Filter valid dates
    const validDates = [];
    for (const d of datesToProcess) {
      const dObj = new Date(d + 'T12:00:00Z');
      const dow = dObj.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      
      // Si estamos forzando no fines de semana, o siempre rechazar en single mode
      if (isWeekend && (no_weekends || !end_date)) {
        if (!end_date) return res.status(400).json({ error: 'No se pueden registrar excusas en fines de semana.' });
        continue; // Skip weekend in range
      }
      
      if (periods && periods.start_date && periods.end_date) {
        if (d < periods.start_date || d > periods.end_date) {
           if (!end_date) return res.status(400).json({ error: `La fecha ${d} está fuera del período académico activo.` });
           continue; // Skip out of period in range
        }
      }
      
      if (holidaysSet.has(d)) {
         if (!end_date) return res.status(400).json({ error: `La fecha seleccionada es un día festivo.` });
         continue; // Skip holiday in range
      }
      
      validDates.push(d);
    }
    
    if (validDates.length === 0) {
       return res.status(400).json({ error: 'No hay días laborables/válidos en el rango o fecha seleccionada.' });
    }

    const horasArr = Array.isArray(horas) && horas.length > 0 ? horas : null;
    let registeredExcusas = [];

    // ── Helper: get scheduled hours for this student/course on specific date ──
    async function getScheduledHours(cid, specificDate) {
      if (!cid) return [];
      const dateObj     = new Date(specificDate + 'T12:00:00Z');
      const jsDay       = dateObj.getUTCDay();
      const dbDayOfWeek = jsDay === 0 ? 7 : jsDay;
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id, teacher_id').eq('course_id', cid);
      if (!tcRows || !tcRows.length) return [];
      const tcIds = tcRows.map(tc => tc.id);
      const { data: schedHours } = await sb.from('raice_schedules')
        .select('class_hour, teacher_course_id')
        .in('teacher_course_id', tcIds)
        .eq('day_of_week', dbDayOfWeek);
      const tcTeacherMap = {};
      tcRows.forEach(tc => { tcTeacherMap[tc.id] = tc.teacher_id; });
      return (schedHours || []).map(s => ({
        class_hour: s.class_hour,
        teacher_id: tcTeacherMap[s.teacher_course_id] || null
      }));
    }

    for (const d of validDates) {
      // 1. Save excusa
      const { data: excusa, error: excErr } = await sb.from('raice_excusas')
        .upsert({
          student_id,
          course_id: course_id || null,
          date: d,
          motivo,
          horas: horasArr,
          registered_by: user.id
        }, { onConflict: 'student_id,date' })
        .select().single();
      
      if (excErr) return res.status(500).json({ error: excErr.message });
      registeredExcusas.push(excusa);

      // --- NEW: Clean start for attendance on this date ---
      // Before applying new permissions, remove any existing 'PE' records 
      // recorded previously for this student/date to avoid "zombie" data
      await sb.from('raice_attendance')
        .delete()
        .eq('student_id', student_id)
        .eq('date', d)
        .eq('status', 'PE');


      // 2. Fetch/resolve target hours for this specific date
      let targetHours = horasArr;
      if (!targetHours) {
        const scheduled = await getScheduledHours(course_id, d);
        targetHours = scheduled.map(s => s.class_hour);
      }

      if (targetHours && targetHours.length > 0) {
        // Update existing A records to PE
        await sb.from('raice_attendance')
          .update({ status: 'PE' })
          .eq('student_id', student_id)
          .eq('date', d)
          .eq('status', 'A')
          .in('class_hour', targetHours);

        // Pre-create PE for selected hours not yet recorded
        const { data: existingAtt } = await sb.from('raice_attendance')
          .select('class_hour')
          .eq('student_id', student_id)
          .eq('date', d);

        const existingHours = new Set((existingAtt || []).map(a => a.class_hour));

        const scheduled = course_id ? await getScheduledHours(course_id, d) : [];
        const teacherByHour = {};
        scheduled.forEach(s => { teacherByHour[s.class_hour] = s.teacher_id; });

        const toInsert = targetHours
          .filter(h => !existingHours.has(h))
          .map(h => ({
            student_id,
            course_id: course_id || null,
            teacher_id: teacherByHour[h] || null,
            date: d,
            class_hour: h,
            status: 'PE'
          }));

        if (toInsert.length) {
          await sb.from('raice_attendance').upsert(toInsert,
            { onConflict: 'student_id,date,course_id,class_hour', ignoreDuplicates: true });
        }
      }
    }

    const horasText = horasArr ? `horas: ${horasArr.join(',')}` : 'todas las horas';
    const datesDesc = end_date ? `rango ${date} al ${end_date}` : `${date} (${horasText})`;
    await logActivity(sb, user.id, 'excusa',
      `Excusa: estudiante ${student_id} — ${datesDesc}: ${motivo.substring(0,60)}`);
      
    return res.status(200).json({ success: true, excusa: registeredExcusas[0], count: registeredExcusas.length });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });

    // 1. Fetch the excuse record first to know what to clean up
    const { data: excData } = await sb.from('raice_excusas').select('student_id, date, horas').eq('id', id).maybeSingle();
    
    if (excData) {
      // 2. Clean up associated PE (Permission) records in attendance
      // If we delete the PE record, the student returns to "unrecorded" (or Absent if teachers weren't using the system correctly)
      let attQuery = sb.from('raice_attendance')
        .delete()
        .eq('student_id', excData.student_id)
        .eq('date', excData.date)
        .eq('status', 'PE');
      
      // If a specific set of hours was assigned, only delete those
      if (excData.horas && Array.isArray(excData.horas) && excData.horas.length > 0) {
        attQuery = attQuery.in('class_hour', excData.horas);
      }
      
      const { error: cleanupErr } = await attQuery;
      if (cleanupErr) console.error('Error cleaning up attendance for deleted excuse:', cleanupErr);
    }

    // 3. Delete the excuse record
    await sb.from('raice_excusas').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}

// ---- TIPO I ESCALONES ----
async function handleTipo1Escalones(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const case_id = url.searchParams.get('case_id');
    if (!case_id) return res.status(400).json({ error: 'case_id requerido' });

    // Verify access: teacher owns the case OR coordinator/superadmin
    if (user.role === 'teacher') {
      const { data: c } = await sb.from('raice_cases').select('teacher_id').eq('id', case_id).single();
      if (!c || c.teacher_id !== user.id)
        return res.status(403).json({ error: 'Sin acceso a este caso' });
    }

    const { data, error } = await sb.from('raice_tipo1_escalones')
      .select('*').eq('case_id', case_id).order('numero_escalon');
    if (error) return res.status(500).json({ error: 'Error al cargar escalones' });
    return res.status(200).json({ escalones: data || [] });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin', 'teacher');
    const { case_id, descripcion, descargos, compromiso, compromiso_fecha, garante } = req.body || {};
    if (!case_id || !descripcion) return res.status(400).json({ error: 'Datos incompletos' });

    // Verify teacher owns this case
    const { data: caseRow } = await sb.from('raice_cases')
      .select('teacher_id, type, status, student_name, grade, course').eq('id', case_id).single();
    if (!caseRow) return res.status(404).json({ error: 'Caso no encontrado' });
    if (user.role === 'teacher' && caseRow.teacher_id !== user.id)
      return res.status(403).json({ error: 'No eres el docente de este caso' });
    if (caseRow.type !== 1)
      return res.status(400).json({ error: 'Solo casos Tipo I tienen escalones' });
    if (caseRow.status === 'escalado')
      return res.status(400).json({ error: 'Este caso ya fue escalado a Tipo II' });
    if (caseRow.status === 'closed' && !isCierre)
      return res.status(400).json({ error: 'Este caso ya fue cerrado como resuelto' });

    // Determine next escalon number
    // Determine if this is a closure entry FIRST (before any checks that use isCierre)
    const isCierre = req.body?._cierre === true;

    const { count } = await sb.from('raice_tipo1_escalones')
      .select('id', { count: 'exact', head: true }).eq('case_id', case_id);
    const numero_escalon = (count || 0) + 1;

    if (!isCierre && numero_escalon > 4)
      return res.status(400).json({ error: 'Máximo 4 escalones. Debe escalar a Tipo II.' });
    if (isCierre && numero_escalon > 5)
      return res.status(400).json({ error: 'Caso ya cerrado' });

    const tipoMap = { 1:'verbal', 2:'escrito', 3:'escrito_con_mediador', 4:'citacion_acudiente' };
    const tipo_llamado = isCierre ? 'cierre' : tipoMap[numero_escalon];

    const { data: escalon, error } = await sb.from('raice_tipo1_escalones').insert({
      case_id, numero_escalon, tipo_llamado,
      descripcion, descargos: descargos || null,
      compromiso: compromiso || null,
      compromiso_fecha: compromiso_fecha || null,
      garante: garante || null,
      created_by: user.id,
    }).select().single();

    if (error) return res.status(500).json({ error: 'Error al registrar escalón' });

    // After escalon 4 → mark case as escalated to Tipo II (skip for cierre)
    let escalado = false;
    if (!isCierre && numero_escalon === 4) {
      await sb.from('raice_cases').update({ status: 'escalado', type: 2 }).eq('id', case_id);
      escalado = true;
      // Notify coordinators that it now requires action
      const { data: admins } = await sb.from('raice_users').select('id').eq('role','admin').eq('active',true);
      for (const admin of (admins||[])) {
        await sendNotification(sb, admin.id, user.id, 'new_case',
          `Caso escalado a Tipo II — ${caseRow.student_name}`,
          `Agotó proceso Tipo I · ${caseRow.grade}°${caseRow.course} · Requiere intervención`,
          case_id);
      }
    } else if (!isCierre) {
      // Informative notification for escalones 1-3
      const escalLabels = {1:'Llamado verbal',2:'1er llamado escrito',3:'2do llamado escrito'};
      const { data: admins } = await sb.from('raice_users').select('id').eq('role','admin').eq('active',true);
      for (const admin of (admins||[])) {
        await sendNotification(sb, admin.id, user.id, 'info_tipo1',
          `[Informativo] ${escalLabels[numero_escalon]} — ${caseRow.student_name}`,
          `Escalón ${numero_escalon} registrado · ${caseRow.grade}°${caseRow.course}`,
          case_id);
      }
    }

    await logActivity(sb, user.id, 'tipo1_escalon',
      `Escalón ${numero_escalon} (${tipo_llamado}) registrado en caso ${case_id}`);

    return res.status(200).json({ success: true, escalon, escalado });
  }

  return res.status(405).end();
}

// ---- NUEVO AÑO ESCOLAR (year rollover) ----
async function handleYearRollover(req, res, user) {
  requireRole(user, 'superadmin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    const [studentsRes, coursesRes, configRes] = await Promise.all([
      sb.from('raice_students')
        .select('id, first_name, last_name, grade, course, course_id, status')
        .eq('status', 'active')
        .order('grade').order('course').order('last_name'),
      sb.from('raice_courses')
        .select('id, grade, number')
        .order('grade').order('number'),
      sb.from('raice_config').select('year').eq('id', 1).maybeSingle()
    ]);
    return res.status(200).json({
      students:     studentsRes.data || [],
      courses:      coursesRes.data  || [],
      current_year: configRes.data?.year || new Date().getFullYear()
    });
  }

  if (req.method === 'POST') {
    const { new_year, promotions } = req.body || {};

    // Validaciones de entrada
    const yearNum = parseInt(new_year, 10);
    if (!yearNum || yearNum < 2020 || yearNum > 2100)
      return res.status(400).json({ error: 'new_year debe ser un año válido (2020-2100)' });
    if (!Array.isArray(promotions) || promotions.length === 0)
      return res.status(400).json({ error: 'promotions debe ser un arreglo no vacío' });

    const VALID_ACTIONS = new Set(['promote', 'retain', 'graduate', 'retire']);

    const summary = { promoted: 0, retained: 0, graduated: 0, retired: 0, errors: [] };

    const { data: courses } = await sb.from('raice_courses').select('id, grade, number');
    const courseMap = {};
    (courses || []).forEach(c => { courseMap[c.id] = c; });

    for (const p of promotions) {
      const { student_id, action, to_course_id } = p;

      // Validar campos por fila
      if (!student_id || typeof student_id !== 'string') {
        summary.errors.push(`student_id inválido: ${student_id}`); continue;
      }
      if (!VALID_ACTIONS.has(action)) {
        summary.errors.push(`Acción inválida '${action}' para ${student_id}`); continue;
      }
      try {
        if (action === 'graduate') {
          await sb.from('raice_students').update({ status: 'graduated' }).eq('id', student_id);
          summary.graduated++;
        } else if (action === 'retire') {
          await sb.from('raice_students').update({ status: 'retired' }).eq('id', student_id);
          summary.retired++;
        } else if (action === 'promote' || action === 'retain') {
          if (!to_course_id) { summary.errors.push(`Sin curso destino: ${student_id}`); continue; }
          const { data: student } = await sb.from('raice_students')
            .select('grade, course, course_id').eq('id', student_id).single();
          if (!student) continue;
          const target = courseMap[to_course_id];
          if (!target) { summary.errors.push(`Curso no encontrado: ${to_course_id}`); continue; }
          await sb.from('raice_students').update({
            course_id: to_course_id,
            grade:     target.grade,
            course:    target.number
          }).eq('id', student_id);
          await sb.from('raice_student_grade_history').insert({
            student_id,
            from_grade:    student.grade,
            from_course:   student.course,
            from_course_id: student.course_id,
            to_grade:      target.grade,
            to_course:     target.number,
            to_course_id,
            reason:        action === 'promote' ? 'promotion' : 'other',
            notes:         action === 'promote'
                             ? `Promoción año ${new_year}`
                             : `Repitencia año ${new_year}`,
            changed_by:   user.id,
            changed_at:   new Date().toISOString()
          });
          if (action === 'promote') summary.promoted++;
          else summary.retained++;
        }
      } catch (err) {
        summary.errors.push(`${student_id}: ${err.message}`);
      }
    }

    // Update year in config
    await sb.from('raice_config').update({ year: new_year }).eq('id', 1);

    await logActivity(sb, user.id, 'year_rollover',
      `Inicio año ${new_year}: ${summary.promoted} promovidos, ${summary.retained} repitentes, ${summary.graduated} egresados, ${summary.retired} retirados`);

    return res.status(200).json({ success: true, summary, new_year });
  }

  return res.status(405).end();
}

// ---- RESTAURACIÓN DE BACKUP ----
async function handleBackupImport(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();

  const sb = getSupabase();
  const { backup, confirm_phrase, confirm_username, confirm_password, step,
          tableName, rows, deleteFirst } = req.body || {};

  const errors  = [];
  const results = {};

  async function upsertBatch(tableName, rows, batchSize = 300) {
    if (!rows || !rows.length) return 0;
    let total = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await sb.from(tableName).upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (error) {
        // Si el batch falla, reintentar uno a uno para salvar lo que se pueda
        let recovered = 0;
        for (const row of batch) {
          const { error: sErr } = await sb.from(tableName).upsert(row, { onConflict: 'id', ignoreDuplicates: true });
          if (!sErr) recovered++;
        }
        if (recovered < batch.length) {
          errors.push(`${tableName}: ${error.message} (${recovered}/${batch.length} recuperados)`);
        }
        total += recovered;
      } else {
        total += batch.length;
      }
    }
    return total;
  }

  // ── Paso 2: tablas grandes en paralelo — JWT verificado, sin re-confirmación
  if (step === 2) {
    const [attR, obsR, gradeHistR] = await Promise.all([
      upsertBatch('raice_attendance',            backup?.tables?.attendance            || [], 1000),
      upsertBatch('raice_observations',          backup?.tables?.observations          || []),
      upsertBatch('raice_student_grade_history', backup?.tables?.student_grade_history || []),
    ]);
    results.attendance = attR; results.observations = obsR; results.student_grade_history = gradeHistR;
    return res.status(200).json({
      success: errors.length === 0, results, errors,
      message: errors.length > 0 ? `Datos grandes con ${errors.length} advertencia(s)` : 'Restaurado correctamente'
    });
  }

  // ── Chunk: upsert de un lote pequeño (frontend envía de a 100) ───────────
  if (step === 'chunk') {
    const ALLOWED = new Set(['raice_students', 'raice_acudientes']);
    if (!ALLOWED.has(tableName)) return res.status(400).json({ error: 'Tabla no permitida' });
    if (deleteFirst) {
      // Para estudiantes: borrar TODAS las tablas con FK a students antes de borrar
      if (tableName === 'raice_students') {
        // Orden de borrado: hijos antes que padres (FK cascade manual)
        const depTables = [
          // Nivel 3: dependen de cases
          'raice_tipo1_escalones', 'raice_followups', 'raice_citations', 'raice_commitments',
          // Nivel 2: dependen de students directamente
          'raice_subgroup_members', 'raice_excusas',
          'raice_classroom_removals', 'raice_suspensions',
          'raice_cases',
          // Nivel 1: dependen solo de students
          'raice_observations', 'raice_attendance', 'raice_acudientes',
          'raice_student_grade_history'
        ];
        for (const dt of depTables) {
          try {
            await sb.from(dt).delete().neq('id', '00000000-0000-0000-0000-000000000000');
          } catch (_) { /* tabla puede no existir */ }
        }
      }
      const { error: dErr } = await sb.from(tableName)
        .delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (dErr) errors.push(`delete_${tableName}: ${dErr.message}`);
    }
    let safeRows = rows || [];
    // Para estudiantes: validar status, course_id y code
    if (tableName === 'raice_students') {
      const validStatuses = new Set(['active','transferred','retired','graduated','desertor']);
      // Mapear status comunes que pueden venir del backup con nombre diferente
      const statusMap = {
        'inactive':'retired', 'retirado':'retired', 'activo':'active',
        'transferido':'transferred', 'graduado':'graduated', 'deserción':'desertor',
        'egresado':'graduated', null:'active', undefined:'active', '':'active'
      };
      const { data: existingCourses } = await sb.from('raice_courses').select('id');
      const validIds = new Set((existingCourses || []).map(c => c.id));
      safeRows = safeRows.map(s => {
        let st = s.status;
        if (!validStatuses.has(st)) st = statusMap[st] || 'active';
        return {
          ...s,
          course_id: s.course_id && validIds.has(s.course_id) ? s.course_id : null,
          status: st,
          code: s.code || null,
        };
      });
      // Deduplicar por code (mantener el primero si hay códigos repetidos)
      const seenCodes = new Set();
      safeRows = safeRows.filter(s => {
        if (!s.code) return true;
        if (seenCodes.has(s.code)) return false;
        seenCodes.add(s.code);
        return true;
      });
    }
    const count = await upsertBatch(tableName, safeRows, 100);
    return res.status(200).json({ success: errors.length === 0, imported: count, errors });
  }

  // ── Cases: tablas que dependen de estudiantes (pequeñas, una sola llamada) ─
  if (step === 'cases') {
    const tc = backup?.tables || {};
    const importedUserIds2  = new Set((tc.teachers || []).map(u => u.id));
    const validStats2 = new Set(['open', 'tracking', 'closed']);

    // Obtener estudiantes que realmente existen en BD (importados en step chunk)
    const { data: existingStudents } = await sb.from('raice_students').select('id');
    const validStudentIds = new Set((existingStudents || []).map(s => s.id));

    const casesFixed2 = (tc.cases || [])
      .filter(c => !c.student_id || validStudentIds.has(c.student_id)) // solo casos de estudiantes existentes
      .map(c => ({
        ...c,
        falta_id:  null,
        teacher_id: c.teacher_id && importedUserIds2.has(c.teacher_id) ? c.teacher_id : null,
        closed_by: c.closed_by && importedUserIds2.has(c.closed_by) ? c.closed_by : null,
        status:    validStats2.has(c.status) ? c.status : 'tracking',
      }));

    // Casos primero (las demás tablas dependen de case_id)
    results.cases = await upsertBatch('raice_cases', casesFixed2);

    // IDs de casos importados exitosamente para validar FKs
    const validCaseIds = new Set(casesFixed2.map(c => c.id));

    // Limpiar FKs de teacher_id en tablas dependientes
    const safeSuspensions = (tc.suspensions || [])
      .filter(s => !s.student_id || validStudentIds.has(s.student_id))
      .map(s => ({
        ...s,
        coordinator_id: s.coordinator_id && importedUserIds2.has(s.coordinator_id) ? s.coordinator_id : null,
      }));
    const safeRemovals = (tc.classroom_removals || [])
      .filter(r => !r.student_id || validStudentIds.has(r.student_id))
      .map(r => ({
        ...r, teacher_id: r.teacher_id && importedUserIds2.has(r.teacher_id) ? r.teacher_id : null,
      }));
    const safeEscalones = (tc.tipo1_escalones || []).filter(e => validCaseIds.has(e.case_id));

    const [followupsR, citationsR, commitmentsR, suspensionsR, classroomR] = await Promise.all([
      upsertBatch('raice_followups',          tc.followups),
      upsertBatch('raice_citations',          tc.citations),
      upsertBatch('raice_commitments',        tc.commitments),
      upsertBatch('raice_suspensions',        safeSuspensions),
      upsertBatch('raice_classroom_removals', safeRemovals),
    ]);
    results.followups = followupsR; results.citations = citationsR;
    results.commitments = commitmentsR; results.suspensions = suspensionsR;
    results.classroom_removals = classroomR;
    results.tipo1_escalones = await upsertBatch('raice_tipo1_escalones', safeEscalones);
    // Excusas: limpiar registered_by FK + filtrar student_id válido
    const safeExcusas = (tc.excusas || [])
      .filter(e => !e.student_id || validStudentIds.has(e.student_id))
      .map(e => ({
        ...e,
        registered_by: e.registered_by && importedUserIds2.has(e.registered_by) ? e.registered_by : null,
      }));
    try { results.excusas = await upsertBatch('raice_excusas', safeExcusas); } catch (_) {}

    // ── Miembros de subgrupos (depende de estudiantes y cursos ya importados) ──
    if (tc.subgroup_members?.length) {
      const validStudentIds = new Set((tc.students || []).map(s => s.id));
      const validCourseIds  = new Set((tc.courses  || []).map(c => c.id));
      const safeMembers = tc.subgroup_members.filter(
        m => validStudentIds.has(m.student_id) && validCourseIds.has(m.subgroup_course_id)
      );
      if (safeMembers.length) {
        const { error } = await sb.from('raice_subgroup_members')
          .upsert(safeMembers, { onConflict: 'id', ignoreDuplicates: true });
        if (error) errors.push('subgroup_members: ' + error.message);
        else results.subgroup_members = safeMembers.length;
      }
    }

    return res.status(200).json({ success: errors.length === 0, results, errors });
  }

  // ── Paso 1: todo excepto asistencia — requiere confirmación ───────────────
  // Rate limit solo en el paso inicial (operación destructiva)
  if (!checkRateLimit(req, res)) return;
  if ((confirm_phrase || '').trim().toUpperCase() !== 'RESTAURAR') {
    return res.status(400).json({ error: 'Frase de confirmación incorrecta. Escribe exactamente: RESTAURAR' });
  }
  if (!confirm_username || !confirm_password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  }
  // Verificar credenciales del superadmin contra la BD
  const { data: adminRow } = await sb.from('raice_users')
    .select('id, password_hash, role')
    .eq('username', confirm_username.trim())
    .eq('role', 'superadmin')
    .maybeSingle();
  if (!adminRow) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const passwordOk = await bcrypt.compare(confirm_password, adminRow.password_hash);
  if (!passwordOk) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!backup || !backup.tables) {
    return res.status(400).json({ error: 'Archivo de backup inválido o sin datos' });
  }

  const t = backup.tables;

  // ── 0. Sedes — sin dependencias externas, deben existir antes de cursos/usuarios ──
  if (t.sedes?.length) {
    results.sedes = await upsertBatch('raice_sedes', t.sedes);
  }

  // ── 1. Sin dependencias externas ─────────────────────────────────────────
  if (t.config?.length) {
    // Solo importar columnas conocidas para evitar fallos por columnas extra en el backup
    const c = t.config[0];
    const safeConfig = {
      id: c.id ?? 1,
      school_name: c.school_name, location: c.location, dane_code: c.dane_code,
      year: c.year, logo_url: c.logo_url, num_periods: c.num_periods,
      periods_config: c.periods_config, classes_per_day: c.classes_per_day,
      session_timeout: c.session_timeout, correction_window: c.correction_window,
      correction_window_minutes: c.correction_window_minutes,
      correction_window_hour: c.correction_window_hour,
      backup_email: c.backup_email, resend_api_key: c.resend_api_key,
    };
    const { error } = await sb.from('raice_config').upsert(safeConfig, { onConflict: 'id' });
    if (error) errors.push('config: ' + error.message);
    else results.config = 1;
  }
  // Faltas catálogo: borrar antes de importar para evitar UNIQUE(tipo,categoria,numeral)
  if (t.faltas_catalogo?.length) {
    await sb.from('raice_faltas_catalogo').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
  results.faltas_catalogo = await upsertBatch('raice_faltas_catalogo', t.faltas_catalogo);
  results.bell_schedule   = await upsertBatch('raice_bell_schedule',   t.bell_schedule);
  // Períodos: borrar los del mismo año antes de importar para evitar conflicto UNIQUE(year,period_num)
  if (t.periods?.length) {
    const years = [...new Set(t.periods.map(p => p.year).filter(Boolean))];
    for (const y of years) await sb.from('raice_periods').delete().eq('year', y);
  }
  results.periods = await upsertBatch('raice_periods', t.periods);
  // Calendario: filtrar types válidos según CHECK constraint
  const validCalTypes = new Set(['holiday','vacation','event','institutional_day']);
  const safeCalendar = (t.calendar || []).filter(e => validCalTypes.has(e.type));
  results.calendar = await upsertBatch('raice_calendar', safeCalendar);
  if ((t.calendar||[]).length !== safeCalendar.length) {
    errors.push(`raice_calendar: ${(t.calendar||[]).length - safeCalendar.length} evento(s) omitidos por tipo inválido`);
  }

  // ── 2. Cursos (sin director aún) — 2 queries en vez de N ─────────────────
  if (t.courses?.length) {
    const backupCourseIds = new Set(t.courses.map(c => c.id));
    const { data: existingCourses } = await sb.from('raice_courses').select('id');
    const toDelete = (existingCourses || []).filter(c => !backupCourseIds.has(c.id)).map(c => c.id);
    if (toDelete.length) await sb.from('raice_courses').delete().in('id', toDelete);
  }
  const coursesNullDir = (t.courses || []).map(c => ({ ...c, director_id: null }));
  results.courses = await upsertBatch('raice_courses', coursesNullDir);

  // ── 3. Usuarios (docentes) — batch upsert preservando password_hash ───────
  if (t.teachers?.length) {
    const ids = t.teachers.map(u => u.id);
    const { data: existing } = await sb.from('raice_users')
      .select('id, password_hash').in('id', ids);
    const existingMap = Object.fromEntries((existing || []).map(u => [u.id, u.password_hash]));

    const tempHash = await bcrypt.hash('Cambiar123!', 10);
    const usersToUpsert = t.teachers.map(u => ({
      id: u.id, username: u.username, first_name: u.first_name,
      last_name: u.last_name, email: u.email || null,
      role: u.role, active: u.active ?? true,
      // Mantener contraseña existente; para usuarios nuevos usar hash temporal
      password_hash: existingMap[u.id] ?? tempHash,
    }));

    // Upsert en lotes — para conflicto de email/username: reintentar uno a uno
    for (let i = 0; i < usersToUpsert.length; i += 50) {
      const batch = usersToUpsert.slice(i, i + 50);
      const { error: uErr } = await sb.from('raice_users')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (uErr) {
        if (uErr.code === '23505') {
          // Conflicto de unique (email o username): reintentar uno a uno
          for (const u of batch) {
            const { error: singleErr } = await sb.from('raice_users')
              .upsert({ ...u, email: null }, { onConflict: 'id', ignoreDuplicates: false });
            if (singleErr) {
              // Si sigue fallando (username duplicado), intentar actualizar sin username
              const { error: finalErr } = await sb.from('raice_users')
                .update({ first_name: u.first_name, last_name: u.last_name, role: u.role, active: u.active })
                .eq('id', u.id);
              if (finalErr) errors.push(`users_upsert(${u.username}): ${finalErr.message}`);
            }
          }
        } else if (uErr.code === '23505_LEGACY' && uErr.message?.toLowerCase().includes('email')) {
          // Ruta legacy — ya no debería entrar aquí
          const { error: retryErr } = await sb.from('raice_users')
            .upsert(batch.map(u => ({ ...u, email: null })), { onConflict: 'id' });
          if (retryErr) errors.push(`users_upsert: ${retryErr.message}`);
          else errors.push('Algunos emails duplicados — importados sin email, actualizar manualmente');
        } else {
          errors.push(`users_upsert: ${uErr.message}`);
        }
      }
    }
    results.users = t.teachers.length;
  }

  // ── 4. Actualizar director_id — 1 upsert en vez de N updates ─────────────
  const coursesWithDir = (t.courses || []).filter(c => c.director_id);
  if (coursesWithDir.length) {
    await sb.from('raice_courses').upsert(
      coursesWithDir.map(c => ({ id: c.id, grade: c.grade, number: c.number, director_id: c.director_id })),
      { onConflict: 'id' }
    );
  }

  // ── 5. Tablas sin dependencia de estudiantes ─────────────────────────────
  // teacher_courses ANTES de schedules (schedules tiene FK a teacher_courses)
  // Filtrar teacher_courses con teacher_id válido
  const importedUserIds = new Set((t.teachers || []).map(u => u.id));
  const safeTeacherCourses = (t.teacher_courses || []).filter(tc => importedUserIds.has(tc.teacher_id));
  results.teacher_courses = await upsertBatch('raice_teacher_courses', safeTeacherCourses);

  // schedules: borrar existentes y reimportar (unique es composite, no por id)
  if (t.schedules?.length) {
    await sb.from('raice_schedules').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
  const validTcIds = new Set(safeTeacherCourses.map(tc => tc.id));
  const safeSchedules = (t.schedules || []).filter(s => !s.teacher_course_id || validTcIds.has(s.teacher_course_id));
  results.schedules = await upsertBatch('raice_schedules', safeSchedules);

  // Paralelo: absences y replacements (sin FK a schedules)
  const [teacherAbsR, absReplR] = await Promise.all([
    upsertBatch('raice_teacher_absences',     t.teacher_absences),
    upsertBatch('raice_absence_replacements', t.absence_replacements),
  ]);
  results.teacher_absences = teacherAbsR; results.absence_replacements = absReplR;

  // ── 6. Asignaciones de sedes a coordinadores ─────────────────────────────
  if (t.user_sedes?.length) {
    // raice_user_sedes tiene PK compuesta (user_id, sede_id)
    const validUserIds = new Set((t.teachers || []).map(u => u.id));
    const validSedeIds = new Set((t.sedes    || []).map(s => s.id));
    const safeUserSedes = t.user_sedes.filter(r => validUserIds.has(r.user_id) && validSedeIds.has(r.sede_id));
    if (safeUserSedes.length) {
      const { error } = await sb.from('raice_user_sedes')
        .upsert(safeUserSedes, { onConflict: 'user_id,sede_id', ignoreDuplicates: true });
      if (error) errors.push('user_sedes: ' + error.message);
      else results.user_sedes = safeUserSedes.length;
    }
  }

  await logActivity(sb, user.id, 'backup_import',
    `Backup v${backup.version||'?'} paso-1 restaurado. Errores: ${errors.length}`);

  const role_stats = {
    role_teachers:     (t.teachers || []).filter(u => u.role === 'teacher').length,
    role_coordinators: (t.teachers || []).filter(u => u.role === 'admin').length,
    role_rectores:     (t.teachers || []).filter(u => u.role === 'rector').length,
  };

  return res.status(200).json({
    success: errors.length === 0,
    results,
    role_stats,
    errors,
    message: errors.length > 0
      ? `Restaurado con ${errors.length} advertencia(s)`
      : 'Backup restaurado correctamente'
  });
}

// ---- PORTAL PÚBLICO DEL ACUDIENTE (acceso por número de documento) ----
async function handlePortalAcudiente(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store');

  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const doc = url.searchParams.get('doc')?.trim();

  if (!doc || doc.length < 3) {
    return res.status(400).json({ error: 'Número de documento inválido' });
  }

  // Rate limit por IP+documento: 10 intentos por documento cada 15 min
  if (!checkRateLimitPortal(req, res, doc)) return;

  // Find student by doc_number (any active/graduated status)
  const { data: student } = await sb.from('raice_students')
    .select('id, first_name, last_name, grade, course, course_id, doc_type, doc_number, status')
    .eq('doc_number', doc)
    .in('status', ['active', 'graduated', 'transferred'])
    .maybeSingle();

  if (!student) {
    return res.status(404).json({ error: 'No se encontró ningún estudiante con ese número de documento.' });
  }

  const sid = student.id;

  // Fetch all relevant data in parallel
  const courseId = student.course_id;
  const [casesRes, attRes, obsRes, suspRes, remRes, configRes, commitmentsRes, excusasRes, acudientesRes] = await Promise.all([
    sb.from('raice_cases')
      .select('id, type, description, actions_taken, falta_numeral, falta_descripcion, status, created_at, teacher_id, raice_users!teacher_id(first_name, last_name)')
      .eq('student_id', sid)
      .order('created_at', { ascending: false }),
    sb.from('raice_attendance')
      .select('date, status, class_hour, teacher_id')
      .eq('student_id', sid)
      .order('date', { ascending: false })
      .limit(120),
    sb.from('raice_observations')
      .select('type, text, created_at, raice_users!teacher_id(first_name, last_name)')
      .eq('student_id', sid)
      .order('created_at', { ascending: false })
      .limit(50),
    sb.from('raice_suspensions')
      .select('start_date, end_date, reason, created_at')
      .eq('student_id', sid)
      .order('created_at', { ascending: false }),
    sb.from('raice_classroom_removals')
      .select('date, reason, class_hour, status, created_at')
      .eq('student_id', sid)
      .order('date', { ascending: false })
      .limit(30),
    sb.from('raice_config').select('school_name, year, logo_url').eq('id', 1).maybeSingle(),
    // NEW: Compromisos del estudiante
    sb.from('raice_commitments')
      .select('description, due_date, fulfilled, signed_by, created_at')
      .eq('student_id', sid)
      .order('created_at', { ascending: false }),
    // NEW: Excusas del estudiante (motivo + fecha)
    sb.from('raice_excusas')
      .select('date, motivo, horas, created_at')
      .eq('student_id', sid)
      .order('date', { ascending: false })
      .limit(30),
    // NEW: Acudientes registrados
    sb.from('raice_acudientes')
      .select('name, phone, email, relationship')
      .eq('student_id', sid)
  ]);

  // NEW: Director de grado + asistencia por asignatura
  let director = null;
  let attBySubject = [];
  if (courseId) {
    // Director de grado
    const { data: courseData } = await sb.from('raice_courses')
      .select('director_id, raice_users(first_name, last_name)')
      .eq('id', courseId).maybeSingle();
    if (courseData?.raice_users) {
      director = {
        name: `${courseData.raice_users.first_name} ${courseData.raice_users.last_name}`
      };
    }

    // Asistencia por asignatura + materia/docente de cada registro — atribuir cada
    // hora a la clase REAL del horario. teacher_id por sí solo es ambiguo (un docente
    // dicta varias materias); el horario (curso + día + hora → materia) lo desambigua,
    // funciona para asistencias tomadas por el coordinador, y cubre tanto el curso
    // principal como los SUBGRUPOS a los que asiste el estudiante.
    const attData = attRes.data || [];
    const studentCourseIds = [...new Set(attData.map(a => a.course_id).filter(Boolean))];

    if (studentCourseIds.length) {
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id, subject, teacher_id, course_id')
        .in('course_id', studentCourseIds);
      const tcList = tcRows || [];
      const tcById = {};
      tcList.forEach(t => { tcById[t.id] = t; });

      // Nombres de docentes
      const teacherIds = [...new Set(tcList.map(t => t.teacher_id).filter(Boolean))];
      const teacherMap = {};
      if (teacherIds.length) {
        const { data: us } = await sb.from('raice_users')
          .select('id, first_name, last_name').in('id', teacherIds);
        (us || []).forEach(u => { teacherMap[u.id] = `${u.first_name} ${u.last_name}`; });
      }

      // Horario → slot "curso_día_hora" → { materia, docente }
      const slotInfo = {};
      if (tcList.length) {
        const { data: schedRows } = await sb.from('raice_schedules')
          .select('day_of_week, class_hour, teacher_course_id')
          .in('teacher_course_id', tcList.map(t => t.id));
        (schedRows || []).forEach(s => {
          const tc = tcById[s.teacher_course_id];
          if (tc?.subject) {
            slotInfo[`${tc.course_id}_${s.day_of_week}_${s.class_hour}`] = {
              subject: tc.subject,
              teacher: tc.teacher_id ? (teacherMap[tc.teacher_id] || null) : null
            };
          }
        });
      }

      // Enriquecer cada registro con la materia y el docente de ESA clase (curso o subgrupo)
      attData.forEach(a => {
        const info = slotInfo[`${a.course_id}_${dayOfWeekCO(a.date)}_${a.class_hour}`];
        if (info) { a.subject = info.subject; a.teacher_name = info.teacher; }
      });

      // Asistencia por asignatura (curso principal + subgrupos)
      const subjectStats = {};
      attData.forEach(a => {
        const subject = slotInfo[`${a.course_id}_${dayOfWeekCO(a.date)}_${a.class_hour}`]?.subject;
        if (!subject) return;
        if (!subjectStats[subject]) subjectStats[subject] = { P:0, A:0, T:0, PE:0, S:0, total:0 };
        subjectStats[subject].total++;
        if (subjectStats[subject][a.status] !== undefined) subjectStats[subject][a.status]++;
      });

      attBySubject = Object.entries(subjectStats).map(([subject, s]) => {
        const countable = s.total - s.S - s.PE;
        return {
          subject,
          present: s.P, absent: s.A, late: s.T, permit: s.PE, total: s.total,
          pct: countable > 0 ? Math.round(((s.P + s.T) / countable) * 100) : null
        };
      }).sort((a,b) => (a.pct ?? 999) - (b.pct ?? 999)); // peor % primero
    }
  }

  return res.status(200).json({
    student: {
      first_name:  student.first_name,
      last_name:   student.last_name,
      grade:       student.grade,
      course:      student.course,
      doc_type:    student.doc_type,
      doc_number:  student.doc_number,
      status:      student.status
    },
    cases: (casesRes.data || []).map(c => ({
      ...c,
      teacher_name: c.raice_users ? `${c.raice_users.first_name} ${c.raice_users.last_name}` : null,
      raice_users: undefined
    })),
    attendance:    attRes.data         || [],
    observations: (obsRes.data || []).map(o => ({
      type:         o.type,
      text:         o.text,
      created_at:   o.created_at,
      teacher_name: o.raice_users ? `${o.raice_users.first_name} ${o.raice_users.last_name}` : null
    })),
    suspensions:   suspRes.data        || [],
    removals:      remRes.data         || [],
    commitments:   commitmentsRes.data || [],
    excusas:       excusasRes.data     || [],
    acudientes:    acudientesRes.data  || [],
    att_by_subject: attBySubject,
    director,
    school:        configRes.data      || {}
  });
}

// =====================================================
// REGISTRAR OMISIÓN DE ASISTENCIA (coordinador / superadmin)
// Registra todos los estudiantes activos del curso como Ausentes
// cuando un docente no llamó lista, eliminando la alerta computada.
// =====================================================
async function handleRegisterOmission(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();

  const { course_id, class_hour, date, teacher_id } = req.body || {};
  if (!course_id || !class_hour || !date) {
    return res.status(400).json({ error: 'Datos incompletos: course_id, class_hour y date son requeridos.' });
  }

  const hour = parseInt(class_hour) || 1;

  // Verificar que no exista ya asistencia para este curso+hora+fecha
  const { data: existing } = await sb.from('raice_attendance')
    .select('id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Ya existe asistencia registrada para esta hora.' });
  }

  // Obtener todos los estudiantes activos del curso
  const { data: students, error: stuErr } = await sb.from('raice_students')
    .select('id').eq('course_id', course_id).eq('status', 'active');
  if (stuErr) return res.status(500).json({ error: _dbErr(stuErr) });
  if (!students || students.length === 0) {
    return res.status(404).json({ error: 'No se encontraron estudiantes activos en este curso.' });
  }

  const effectiveTeacherId = teacher_id || user.id;
  const now = new Date().toISOString();
  const rows = students.map(s => ({
    student_id:        s.id,
    course_id,
    teacher_id:        effectiveTeacherId,
    date,
    class_hour:        hour,
    status:            'NR',   // Sin registro — no implica presencia ni ausencia
    corrected_by:      user.id,
    corrected_at:      now,
    correction_reason: 'omision_docente',
  }));

  let { error } = await sb.from('raice_attendance').insert(rows);
  if (error && (error.message.includes('corrected_by') || error.message.includes('correction_reason'))) {
    // Columnas de auditoría aún no migradas — reintento sin ellas
    const rowsBasic = rows.map(({ corrected_by: _a, corrected_at: _b, correction_reason: _c, ...rest }) => rest);
    const res2 = await sb.from('raice_attendance').insert(rowsBasic);
    error = res2.error;
  }
  if (error) return res.status(500).json({ error: _dbErr(error) });

  const { data: courseInfo } = await sb.from('raice_courses')
    .select('grade, number').eq('id', course_id).single();
  const g = courseInfo?.grade || '?', n = courseInfo?.number || '?';
  await logActivity(sb, user.id, 'attendance_correction',
    `Omisión registrada — ${g}°${n} — ${hour}ª hora — ${date} — ${students.length} est. sin registro (NR) — por @${user.username}`);

  return res.status(200).json({ success: true, registered: students.length });
}


// =====================================================
// SEDES
// =====================================================
async function handleSedes(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    let query = sb.from('raice_sedes')
      .select('id, name, type, address, active, created_at')
      .order('name');
      
    if (user.role === 'admin') {
      // Siempre leer desde la BD — el JWT puede estar desactualizado
      const adminSedeIds = await getAdminSedeIds(sb, user);
      if (adminSedeIds && adminSedeIds.length > 0) {
        query = query.in('id', adminSedeIds);
      } else {
        query = query.in('id', ['00000000-0000-0000-0000-000000000000']);
      }
    }
      
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Error al cargar sedes' });
    const sedes = data || [];

    // stats=true: añade conteos de estudiantes, casos activos y asistencia de hoy por sede
    if (url.searchParams.get('stats') === 'true' && sedes.length) {
      const today = todayCO().split('T')[0];
      const sedeIds = sedes.map(s => s.id);

      // 1. Contar estudiantes por sede (a través de raice_courses)
      const { data: courseRows } = await sb.from('raice_courses')
        .select('id, sede_id').in('sede_id', sedeIds).neq('type', 'subgroup');
      const courseIdsBySede = {};
      (courseRows || []).forEach(c => {
        if (!courseIdsBySede[c.sede_id]) courseIdsBySede[c.sede_id] = [];
        courseIdsBySede[c.sede_id].push(c.id);
      });
      const allCourseIds = (courseRows || []).map(c => c.id);

      // 2. Contar estudiantes por curso
      const studentsMap = {}; // sedeId → count
      if (allCourseIds.length) {
        const { data: stRows } = await sb.from('raice_students')
          .select('course_id').in('course_id', allCourseIds).eq('status', 'active');
        const courseSedeMap = {};
        (courseRows || []).forEach(c => { courseSedeMap[c.id] = c.sede_id; });
        (stRows || []).forEach(s => {
          const sid = courseSedeMap[s.course_id];
          if (sid) studentsMap[sid] = (studentsMap[sid] || 0) + 1;
        });
      }

      // 3. Asistencia de hoy por sede
      const attMap = {}; // sedeId → {P,A,T,E}
      if (allCourseIds.length) {
        const { data: attRows } = await sb.from('raice_attendance')
          .select('course_id, status').in('course_id', allCourseIds).eq('date', today);
        const courseSedeMap = {};
        (courseRows || []).forEach(c => { courseSedeMap[c.id] = c.sede_id; });
        (attRows || []).forEach(r => {
          const sid = courseSedeMap[r.course_id];
          if (!sid) return;
          if (!attMap[sid]) attMap[sid] = { P:0, A:0, T:0, E:0 };
          attMap[sid][r.status] = (attMap[sid][r.status] || 0) + 1;
        });
      }

      // 4. Casos activos por sede
      const casesMap = {}; // sedeId → count
      if (allCourseIds.length) {
        const { data: caseRows } = await sb.from('raice_cases')
          .select('course_id').in('course_id', allCourseIds).eq('status', 'open');
        const courseSedeMap = {};
        (courseRows || []).forEach(c => { courseSedeMap[c.id] = c.sede_id; });
        (caseRows || []).forEach(c => {
          const sid = courseSedeMap[c.course_id];
          if (sid) casesMap[sid] = (casesMap[sid] || 0) + 1;
        });
      }

      const sedesWithStats = sedes.map(s => ({
        ...s,
        students:     studentsMap[s.id] || 0,
        att_today:    attMap[s.id] || { P:0, A:0, T:0, E:0 },
        active_cases: casesMap[s.id] || 0,
      }));
      return res.status(200).json({ sedes: sedesWithStats });
    }

    return res.status(200).json({ sedes });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin');
    const { name, type, address } = req.body || {};
    if (!name) return res.status(400).json({ error: 'El nombre de la sede es requerido' });
    const { data, error } = await sb.from('raice_sedes')
      .insert({ name, type: type || 'mixta', address: address || null })
      .select().single();
    if (error) return res.status(500).json({ error: 'Error al crear sede' });
    await logActivity(sb, user.id, 'create_sede', `Sede creada: ${name}`);
    return res.status(200).json({ success: true, sede: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin');
    const { id, name, type, address, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (name    !== undefined) updates.name    = name;
    if (type    !== undefined) updates.type    = type;
    if (address !== undefined) updates.address = address;
    if (active  !== undefined) updates.active  = active;
    const { error } = await sb.from('raice_sedes').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al actualizar sede' });
    await logActivity(sb, user.id, 'update_sede', `Sede ${id} actualizada`);
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const [uCount, cCount] = await Promise.all([
      sb.from('raice_users').select('id', { count: 'exact', head: true }).eq('sede_id', id),
      sb.from('raice_courses').select('id', { count: 'exact', head: true }).eq('sede_id', id),
    ]);
    if ((uCount.count || 0) + (cCount.count || 0) > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar: la sede tiene usuarios o cursos asignados',
        refs: { users: uCount.count || 0, courses: cCount.count || 0 }
      });
    }
    const { error } = await sb.from('raice_sedes').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar sede' });
    await logActivity(sb, user.id, 'delete_sede', `Sede ${id} eliminada`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ---- AUXILIAR: REEVALUAR EVASIONES EN CASO DE CAMBIO/CORRECCIÓN ----
async function reevaluateEvasions(sb, courseId, date, studentIds) {
  if (!studentIds || studentIds.length === 0) return;

  // 1. Obtener toda la asistencia del día para estos estudiantes en el curso
  const { data: dayAtt } = await sb.from('raice_attendance')
    .select('student_id, status, class_hour')
    .eq('course_id', courseId)
    .eq('date', date)
    .in('student_id', studentIds);

  if (!dayAtt) return;

  // Agrupar asistencias por estudiante
  const studentMap = {};
  studentIds.forEach(sid => { studentMap[sid] = []; });
  dayAtt.forEach(r => {
    if (studentMap[r.student_id]) {
      studentMap[r.student_id].push(r);
    }
  });

  // 2. Analizar cada estudiante
  for (const sid of studentIds) {
    const records = studentMap[sid] || [];
    
    // Buscar si existe un patrón de evasión activo:
    // Al menos una hora H >= 2 con 'A', y alguna hora H_prev < H con 'P'
    let hasEvasionPattern = false;
    
    // Filtrar horas con 'A' (horas >= 2)
    const absentHours = records.filter(r => r.status === 'A' && r.class_hour >= 2);
    
    for (const absRec of absentHours) {
      const H = absRec.class_hour;
      // Verificar si hay algún registro anterior con 'P'
      const hasPrevP = records.some(r => r.status === 'P' && r.class_hour < H);
      if (hasPrevP) {
        hasEvasionPattern = true;
        break;
      }
    }

    // 3. Si NO tiene patrón de evasión, retractar cualquier alerta activa
    if (!hasEvasionPattern) {
      await sb.from('raice_notifications')
        .update({ type: 'evasion_retracted', read: false })
        .eq('type', 'evasion')
        .eq('link_id', sid)
        .like('body', `%${date}%`);
    }
  }
}

