import { UserRepository } from '../../src/data/repositories/UserRepository.js';
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
    if (route === 'raice/acudientes')           return await handleAcudientes(req, res, user);
    if (route === 'raice/calendar/today')       return await handleCalendarToday(req, res, user);
    if (route === 'raice/calendar/range')       return await handleCalendarRange(req, res, user);
    if (route === 'raice/calendar')             return await handleCalendar(req, res, user);
    if (route === 'raice/reports/attendance')   return await reportAttendance(req, res, user);
    if (route === 'raice/reports/attendance-v2') return await reportAttendanceV2(req, res, user);
    if (route === 'raice/reports/cases')        return await reportCases(req, res, user);
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

async function logActivity(sb, userId, type, detail) {
  try {
    await sb.from('raice_logs').insert({ user_id: userId, event_type: type, detail });
  } catch (_) { /* silencioso */ }
}

// =====================================================
// DASHBOARD (v2 — único dashboard activo)
// =====================================================





// =====================================================
// ALERTS ENDPOINT — combina alertas computadas + notificaciones no leídas
// =====================================================






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
      const { data: teacherCourses } = await sb.from('raice_teacher_courses')
        .select('course_id').eq('teacher_id', user.id);
      const ids = (teacherCourses || []).map(tc => tc.course_id);
      if (ids.length) query = query.in('course_id', ids);
      else return res.status(200).json({ students: [] });
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Error al cargar estudiantes' });
    const students = data || [];

    if (!students.length) return res.status(200).json({ students: [] });

    // Enrich with cases_count and attendance % (current month in Colombia timezone)
    const studentIds = students.map(s => s.id);
    const monthStart = todayCO().substring(0, 8) + '01'; // YYYY-MM-01 in Colombia time

    const [casesRes, attRes] = await Promise.all([
      sb.from('raice_cases').select('student_id').in('student_id', studentIds),
      sb.from('raice_attendance')
        .select('student_id, status')
        .in('student_id', studentIds)
        .gte('date', monthStart)
    ]);

    // Build cases map
    const casesMap = {};
    (casesRes.data || []).forEach(c => {
      casesMap[c.student_id] = (casesMap[c.student_id] || 0) + 1;
    });

    // Build attendance map
    const attMap = {};
    (attRes.data || []).forEach(a => {
      if (!attMap[a.student_id]) attMap[a.student_id] = { total: 0, present: 0 };
      attMap[a.student_id].total++;
      if (a.status === 'P' || a.status === 'PE') attMap[a.student_id].present++;
    });

    const enriched = students.map(s => ({
      ...s,
      cases_count: casesMap[s.id] || 0,
      att_pct: attMap[s.id] && attMap[s.id].total > 0
        ? Math.round((attMap[s.id].present / attMap[s.id].total) * 100)
        : null
    }));

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









// =====================================================
// COURSES
// =====================================================



// =====================================================
// SUBGROUP MEMBERS
// =====================================================



// =====================================================
// MY COURSES (Teacher)
// =====================================================



// =====================================================
// ASISTENCIA FALTANTE — clases sin registro para una fecha
// =====================================================


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
    let prevTardyIds = new Set();
    if (['superadmin', 'admin'].includes(user.role)) {
      // Look up who originally recorded this hour so we preserve their teacher_id
      const { data: origRow } = await sb.from('raice_attendance')
        .select('teacher_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).limit(1);
      if (origRow && origRow[0]?.teacher_id) originalTeacherId = origRow[0].teacher_id;

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

    await logActivity(sb, user.id, 'attendance',
      `Asistencia ${hour}ª hora — Curso ${course_id} — ${date}`);
    return res.status(200).json({ success: true, saved: rows.length, tardes: tardes.length, evasiones });
  }

  if (req.method === 'GET') {
    requireRole(user, 'superadmin', 'admin');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const date_from = url.searchParams.get('date_from');
    const date_to   = url.searchParams.get('date_to');

    // ── RANGE MODE (semana / mes / período / año) ────────────────────
    if (date_from && date_to) {
      const { data: attData } = await sb.from('raice_attendance')
        .select('status, course_id, class_hour, student_id, teacher_id, date')
        .gte('date', date_from).lte('date', date_to);

      // Deduplicate: per student + course + date → keep last hour's status
      const scdMap = {};
      (attData||[]).forEach(r => {
        const key = `${r.student_id}_${r.course_id}_${r.date}`;
        if (!scdMap[key] || r.class_hour > scdMap[key].class_hour) scdMap[key] = r;
      });
      const deduped = Object.values(scdMap);

      const present = deduped.filter(r => ['P','PE','S'].includes(r.status)).length;
      const absent  = deduped.filter(r => r.status === 'A').length;
      const permit  = deduped.filter(r => r.status === 'PE').length;
      const late    = deduped.filter(r => r.status === 'T').length;

      // Course + teacher lookups
      const cIds = [...new Set(deduped.map(r => r.course_id).filter(Boolean))];
      const tIds = [...new Set(deduped.map(r => r.teacher_id).filter(Boolean))];
      const courseMap2 = {}, teacherMap2 = {};
      if (cIds.length) {
        const { data: cr } = await sb.from('raice_courses').select('id,grade,number').in('id', cIds);
        (cr||[]).forEach(c => courseMap2[c.id] = c);
      }
      if (tIds.length) {
        const { data: tr } = await sb.from('raice_users').select('id,first_name,last_name').in('id', tIds);
        (tr||[]).forEach(t => teacherMap2[t.id] = `${t.first_name} ${t.last_name}`);
      }

      const byCourse = {};
      deduped.forEach(r => {
        if (!r.course_id) return;
        if (!byCourse[r.course_id]) {
          const c = courseMap2[r.course_id] || {};
          byCourse[r.course_id] = {
            course_id: r.course_id,
            grade: c.grade ?? '?', course: c.number ?? '?',
            teacher: teacherMap2[r.teacher_id] || '—',
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
      const { data: rawData } = await sb.from('raice_attendance')
        .select('student_id, class_hour, status, course_id')
        .eq('date', date);

      if (!rawData?.length) return res.status(200).json({ hours: [], students: [] });

      const stuIds = [...new Set(rawData.map(r => r.student_id).filter(Boolean))];
      const cIds   = [...new Set(rawData.map(r => r.course_id).filter(Boolean))];

      const [stuRes, crsRes] = await Promise.all([
        stuIds.length ? sb.from('raice_students').select('id,first_name,last_name').in('id', stuIds) : Promise.resolve({ data: [] }),
        cIds.length   ? sb.from('raice_courses').select('id,grade,number').in('id', cIds)           : Promise.resolve({ data: [] }),
      ]);

      const stuMap = {};
      (stuRes.data||[]).forEach(s => stuMap[s.id] = `${s.last_name}, ${s.first_name}`);
      const cMap = {};
      (crsRes.data||[]).forEach(c => cMap[c.id] = c);

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
            by_hour: {}
          };
        }
        byStudent[r.student_id].by_hour[r.class_hour] = r.status;
      });

      const students = Object.values(byStudent)
        .sort((a,b) => (a.grade - b.grade) || String(a.course).localeCompare(String(b.course)) || a.name.localeCompare(b.name));

      return res.status(200).json({ hours, students });
    }

    // Get attendance without FK joins to avoid name issues
    const { data: attData } = await sb.from('raice_attendance')
      .select('status, course_id, class_hour, student_id, teacher_id').eq('date', date);

    // Deduplicate: if a student has multiple hours, use the most recent status per student per course
    const studentCourseMap = {};
    (attData||[]).forEach(r => {
      const key = r.student_id + '_' + r.course_id;
      if (!studentCourseMap[key] || r.class_hour > studentCourseMap[key].class_hour) {
        studentCourseMap[key] = r;
      }
    });
    const deduped = Object.values(studentCourseMap);

    const present = deduped.filter(r => r.status === 'P' || r.status === 'PE').length;
    const absent  = deduped.filter(r => r.status === 'A').length;
    const permit  = deduped.filter(r => r.status === 'PE').length;
    const late    = deduped.filter(r => r.status === 'T').length;

    // Get course details
    const courseIds = [...new Set((attData||[]).map(r => r.course_id).filter(Boolean))];
    const courseMap = {};
    if (courseIds.length) {
      const { data: courseRows } = await sb.from('raice_courses')
        .select('id, grade, number').in('id', courseIds);
      (courseRows||[]).forEach(c => courseMap[c.id] = c);
    }

    // Get teacher names per course
    const teacherIds = [...new Set((attData||[]).map(r => r.teacher_id).filter(Boolean))];
    const teacherMap = {};
    if (teacherIds.length) {
      const { data: teacherRows } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', teacherIds);
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
        course:  c.number ?? key,   // fallback to ID if number not configured
        teacher: teacherMap[r.teacher_id] || '—',
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
      return { ...c, teachers_by_hour, pct: c.total > 0 ? Math.round((c.present / c.total) * 100) : 0 };
    }).sort((a,b) => a.grade - b.grade || a.course - b.course);

    return res.status(200).json({ present, absent, permit, late, courses });
  }

  return res.status(405).end();
}






// =====================================================





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



// Expose Supabase public credentials for Realtime subscriptions




// =====================================================
// LOGS
// =====================================================




// =====================================================
// FASE 2 — NUEVOS ENDPOINTS
// =====================================================

// ---- CASE DETAIL ----


// ---- CASES REPORT (period range) ----





// ---- CASE FOLLOWUP ----


// ---- COMMITMENTS ----




// ---- STUDENT HISTORY ----


// ---- STUDENT GRADE HISTORY (endpoint dedicado) ----


// ---- DASHBOARD ENHANCED (Fase 2) ----




// =====================================================
// FASE 3 — PERÍODOS, NOTIFICACIONES, CITACIONES
// =====================================================

// ---- PERÍODOS ----


// ---- SYNC PERIODS ----


// ---- NOTIFICACIONES ----




// ---- CITACIONES ----


// ---- STATS BY PERIOD ----


// ---- TEACHER-COURSES ASSIGNMENT ----


// =====================================================
// TARDANZAS REPORT
// =====================================================


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

  const [studentsRes, casesRes, teachersRes] = await Promise.all([
    sb.from('raice_students').select('id, first_name, last_name, grade, course, phone')
      .or(`first_name.ilike.${term},last_name.ilike.${term}`)
      .eq('status','active').limit(8),
    sb.from('raice_cases').select('id, student_name, type, status, created_at')
      .ilike('student_name', term).limit(5),
    user.role !== 'teacher'
      ? sb.from('raice_users').select('id, first_name, last_name, username, role')
          .or(`first_name.ilike.${term},last_name.ilike.${term},username.ilike.${term}`)
          .eq('active',true).limit(5)
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


// =====================================================
// ACUDIENTES
// =====================================================


// =====================================================
// CALENDARIO ESCOLAR
// =====================================================


// =====================================================
// CALENDARIO — RANGO DE FECHAS (inserción masiva)
// =====================================================


// =====================================================
// CALENDARIO HOY — estado del día actual (Bogotá)
// =====================================================


// =====================================================
// RECUPERAR CONTRASEÑA
// =====================================================


// =====================================================
// REPORTS — ATTENDANCE EXPORT DATA
// =====================================================


// =====================================================
// REPORTS — CASES EXPORT DATA
// =====================================================


// =====================================================
// CRON — REPORTE SEMANAL AUTOMÁTICO (Viernes 6pm)
// =====================================================


// =====================================================
// SCHEDULES — CRUD
// =====================================================


// =====================================================
// BELL SCHEDULE — Global class times config
// =====================================================


// =====================================================
// TEACHER SCHEDULE — Full weekly view for one teacher
// =====================================================


// =====================================================
// PURGE — Superadmin only data maintenance
// =====================================================



// =====================================================
// BACKUP — JSON export, Excel/CSV, Email via Resend
// =====================================================







// =====================================================
// DIRECTOR DE GRADO — casos del grado (solo lectura)
// =====================================================


// =====================================================
// EVASIONES — listado para coordinador/admin
// =====================================================
// =====================================================
// AUSENCIAS DOCENTES Y REEMPLAZOS
// =====================================================









// =====================================================
// RESOLVER EVASIÓN (confirmar / descartar)
// =====================================================



// =====================================================
// FASE 4 — SUSPENSIONES
// =====================================================


// =====================================================
// FASE 4 — DESBLOQUEO DE ASISTENCIA (docente corrige)
// =====================================================


// =====================================================
// REPORTE ASISTENCIA V2 — 3 niveles
// =====================================================


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


// =====================================================
// =====================================================
// CLEANUP ORPHANED PE — Admin/Superadmin only
// PE attendance records that have no matching raice_excusas row
// =====================================================


// =====================================================
// EXCUSAS — Director de grado
// =====================================================


// ---- TIPO I ESCALONES ----


// ---- NUEVO AÑO ESCOLAR (year rollover) ----


// ---- RESTAURACIÓN DE BACKUP ----


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
    .select('id, first_name, last_name, grade, course, doc_type, doc_number, status')
    .eq('doc_number', doc)
    .in('status', ['active', 'graduated', 'transferred'])
    .maybeSingle();

  if (!student) {
    return res.status(404).json({ error: 'No se encontró ningún estudiante con ese número de documento.' });
  }

  const sid = student.id;

  // Fetch all relevant data in parallel
  const [casesRes, attRes, obsRes, suspRes, remRes, configRes] = await Promise.all([
    sb.from('raice_cases')
      .select('id, type, description, actions_taken, falta_numeral, falta_descripcion, status, created_at, teacher_id, raice_users!teacher_id(first_name, last_name)')
      .eq('student_id', sid)
      .order('created_at', { ascending: false }),
    sb.from('raice_attendance')
      .select('date, status, class_hour')
      .eq('student_id', sid)
      .order('date', { ascending: false })
      .limit(120),
    sb.from('raice_observations')
      .select('type, text, created_at')
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
    sb.from('raice_config').select('school_name, year, logo_url').eq('id', 1).maybeSingle()
  ]);

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
    attendance:  attRes.data     || [],
    observations: obsRes.data    || [],
    suspensions:  suspRes.data   || [],
    removals:     remRes.data    || [],
    school:       configRes.data || {}
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
