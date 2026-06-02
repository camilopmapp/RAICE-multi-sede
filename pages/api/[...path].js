import { getSupabase } from '../../src/data/supabaseClient.js';
import { verifyToken } from '../../src/shared/utils/authHelpers.js';
import { UsersController } from '../../src/presentation/controllers/UsersController.js';
import { CoursesController } from '../../src/presentation/controllers/CoursesController.js';
import { CasesController } from '../../src/presentation/controllers/CasesController.js';
import { ReportsController } from '../../src/presentation/controllers/ReportsController.js';
import { ConfigController } from '../../src/presentation/controllers/ConfigController.js';
import { BackupController } from '../../src/presentation/controllers/BackupController.js';
import { SchedulesController } from '../../src/presentation/controllers/SchedulesController.js';
import { AttendanceController } from '../../src/presentation/controllers/AttendanceController.js';
import { StudentsController } from '../../src/presentation/controllers/StudentsController.js';
import { AlertsController } from '../../src/presentation/controllers/AlertsController.js';
import { SedesController } from '../../src/presentation/controllers/SedesController.js';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

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
    if (pathParts[0] === 'auth' && pathParts[1] === 'login') return await UsersController.login(req, res);
    if (pathParts[0] === 'raice' && pathParts[1] === 'acudientes' &&
        (req.headers['authorization']?.startsWith('Bearer ') || new URL(req.url, `http://${req.headers.host}`).searchParams.get('token'))
    ) return await UsersController.handleAcudientes(req, res, null);
    if (pathParts[0] === 'raice' && pathParts[1] === 'recover-password') return await UsersController.recoverPassword(req, res);
    if (pathParts[0] === 'raice' && pathParts[1] === 'portal-acudiente') return await StudentsController.handlePortalAcudiente(req, res);
    // Cron uses its own Bearer CRON_SECRET auth (not JWT) — must be before verifyToken
    if (pathParts[0] === 'raice' && pathParts[1] === 'cron' && pathParts[2] === 'weekly-report') return await ReportsController.cronWeeklyReport(req, res);

    // PROTECTED routes
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });

    // Rector is read-only: block all non-GET methods globally
    if (user.role === 'rector' && req.method !== 'GET') {
      return res.status(403).json({ error: 'El rector solo tiene acceso de lectura. Esta acción no está permitida.' });
    }

    const route = pathParts.join('/');

    // ---- SUPERADMIN & ADMIN routes ----
    if (route === 'raice/sedes')                return await SedesController.handleSedes(req, res, user);
    if (route === 'raice/rector-insights')     return await ReportsController.getRectorInsights(req, res, user);
    if (route === 'raice/dashboard')            return await ReportsController.getDashboardV2(req, res, user);
    if (route === 'raice/alerts')               return await AlertsController.getAlertsEndpoint(req, res, user);
    if (route === 'raice/users')                return await UsersController.handleUsers(req, res, user);
    if (route === 'raice/users/reset-password') return await UsersController.resetUserPassword(req, res, user);
    if (route === 'raice/students')             return await StudentsController.handleStudents(req, res, user);
    if (route === 'raice/students/import')      return await StudentsController.importStudents(req, res, user);
    if (route === 'raice/simat/preview')        return await StudentsController.simatPreview(req, res, user);
    if (route === 'raice/simat/import')         return await StudentsController.simatImport(req, res, user);
    if (route === 'raice/teachers')             return await UsersController.handleTeachers(req, res, user);
    if (route === 'raice/courses')              return await CoursesController.handleCourses(req, res, user);
    if (route === 'raice/subgroup-members')     return await CoursesController.handleSubgroupMembers(req, res, user);
    if (route === 'raice/cases')                return await CasesController.handleCases(req, res, user);
    if (route === 'raice/faltas-catalogo')      return await ConfigController.handleFaltasCatalogo(req, res, user);
    if (route === 'raice/tipo1-escalones')      return await ConfigController.handleTipo1Escalones(req, res, user);
    if (route === 'raice/excusas/cleanup-orphaned') return await AttendanceController.cleanupOrphanedPE(req, res, user);
    if (route === 'raice/excusas')               return await AlertsController.handleExcusas(req, res, user);
    if (route === 'raice/cases/status')         return await CasesController.updateCaseStatus(req, res, user);
    if (route === 'raice/cases/followup')       return await CasesController.saveCaseFollowup(req, res, user);
    if (route === 'raice/cases/report')         return await ReportsController.getCasesReport(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='cases' && pathParts[2]) return await CasesController.getCaseDetail(req, res, user);
    if (route === 'raice/commitments')          return await CasesController.handleCommitments(req, res, user);
    if (route === 'raice/commitments/fulfill')  return await CasesController.fulfillCommitment(req, res, user);
    if (route === 'raice/attendance')           return await AttendanceController.handleAttendance(req, res, user);
    if (route === 'raice/register-omission')   return await StudentsController.handleRegisterOmission(req, res, user);
    if (route === 'raice/config')               return await ConfigController.handleConfig(req, res, user);
    if (route === 'raice/realtime-config')       return await ConfigController.handleRealtimeConfig(req, res, user);
    if (route === 'raice/config/security')      return await ConfigController.handleSecurityConfig(req, res, user);
    if (route === 'raice/logs')                 return await ConfigController.handleLogs(req, res, user);
    if (route === 'raice/purge')                return await BackupController.handlePurge(req, res, user);
    if (route === 'raice/backup/export')        return await BackupController.handleBackupExport(req, res, user);
    if (route === 'raice/backup/csv')           return await BackupController.handleBackupCsv(req, res, user);
    if (route === 'raice/backup/send-email')    return await BackupController.handleBackupEmail(req, res, user);
    if (route === 'raice/backup/import')        return await BackupController.handleBackupImport(req, res, user);
    if (route === 'raice/cron/weekly-report')   return res.status(200).json({ ok: true, message: 'El reporte semanal se genera automáticamente. Revisa el email configurado.' });
    if (route === 'raice/tardanzas')            return await ReportsController.getTardanzasReport(req, res, user);
    if (route === 'raice/search')               return await StudentsController.globalSearch(req, res, user);
    if (route === 'raice/student-ficha')        return await StudentsController.getStudentFicha(req, res, user);
    if (route === 'raice/acudientes')           return await UsersController.handleAcudientes(req, res, user);
    if (route === 'raice/calendar/today')       return await AlertsController.handleCalendarToday(req, res, user);
    if (route === 'raice/calendar/range')       return await AlertsController.handleCalendarRange(req, res, user);
    if (route === 'raice/calendar')             return await AlertsController.handleCalendar(req, res, user);
    if (route === 'raice/reports/attendance')   return await ReportsController.reportAttendance(req, res, user);
    if (route === 'raice/reports/attendance-v2') return await ReportsController.reportAttendanceV2(req, res, user);
    if (route === 'raice/reports/cases')        return await ReportsController.reportCases(req, res, user);
    if (route === 'raice/schedules')            return await SchedulesController.handleSchedules(req, res, user);
    if (route === 'raice/schedules/overview')   return await SchedulesController.getSchedulesOverview(req, res, user);
    if (route === 'raice/bell-schedule')        return await ConfigController.handleBellSchedule(req, res, user);
    if (route === 'raice/teacher-schedule')     return await SchedulesController.getTeacherSchedule(req, res, user);
    if (route === 'raice/my-schedule')          return await SchedulesController.getTeacherSchedule(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='student-history' && pathParts[2]) return await CasesController.getStudentHistory(req, res, user);
    if (pathParts[0]==='raice' && pathParts[1]==='student-grade-history' && pathParts[2]) return await CasesController.getStudentGradeHistory(req, res, user);

    // ---- FASE 3 routes ----
    if (route === 'raice/periods')              return await ConfigController.handlePeriods(req, res, user);
    if (route === 'raice/periods/sync')         return await ConfigController.syncPeriods(req, res, user);
    if (route === 'raice/notifications')        return await AlertsController.handleNotifications(req, res, user);
    if (route === 'raice/citations')            return await AlertsController.handleCitations(req, res, user);
    if (route === 'raice/stats/period')         return await ReportsController.getStatsByPeriod(req, res, user);
    if (route === 'raice/teacher-courses')      return await CoursesController.handleTeacherCourses(req, res, user);

    if (route === 'raice/teacher-absences')                return await SchedulesController.handleTeacherAbsences(req, res, user);
    if (route === 'raice/teacher-absences/replacement')    return await SchedulesController.handleAbsenceReplacement(req, res, user);
    if (route === 'raice/teacher-absences/suggestions')    return await SchedulesController.getReplacementSuggestions(req, res, user);

    // ---- FASE 4 routes ----
    if (route === 'raice/classroom-removals')    return await AlertsController.handleClassroomRemovals(req, res, user);
    if (route === 'raice/suspensions')           return await AlertsController.handleSuspensions(req, res, user);
    if (route === 'raice/attendance/unlock')     return await AttendanceController.unlockAttendance(req, res, user);
    if (route === 'raice/attendance/missing')    return await AttendanceController.getMissingAttendance(req, res, user);

    // ---- TEACHER-SPECIFIC routes ----
    if (route === 'raice/my-courses')           return await CoursesController.getMyCourses(req, res, user);
    if (route === 'raice/attendance/course')    return await AttendanceController.getAttendanceByCourse(req, res, user);
    if (route === 'raice/attendance/range')     return await AttendanceController.getAttendanceRange(req, res, user);
    if (route === 'raice/observations')         return await CasesController.handleObservations(req, res, user);
    if (route === 'raice/my-cases')             return await CasesController.getMyCases(req, res, user);
    if (route === 'raice/change-password')      return await UsersController.changePassword(req, res, user);
    if (route === 'raice/grade-cases')          return await CasesController.getGradeCases(req, res, user);
    if (route === 'raice/evasions')             return await AlertsController.getEvasions(req, res, user);
    if (route === 'raice/evasions/resolve')     return await AlertsController.resolveEvasion(req, res, user);
    if (route === 'raice/year-rollover')        return await ConfigController.handleYearRollover(req, res, user);

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
