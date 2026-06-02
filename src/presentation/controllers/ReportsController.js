import { getSupabase } from '../../data/supabaseClient.js';
import { requireRole, logActivity, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, _dbErr, getAdminSedeIds, getCourseIdsForSedes } from '../../shared/utils/apiHelpers.js';
import { todayCO, dayOfWeekCO } from '../../shared/utils/date.js';
import { checkRateLimit, checkRateLimitPortal, verifyToken } from '../../shared/utils/authHelpers.js';
import { UserRepository } from '../../data/repositories/UserRepository.js';
import { CasesRepository } from '../../data/repositories/CasesRepository.js';
import { ConfigRepository } from '../../data/repositories/ConfigRepository.js';
import { CoursesRepository } from '../../data/repositories/CoursesRepository.js';
import { SchedulesRepository } from '../../data/repositories/SchedulesRepository.js';
import { AttendanceRepository } from '../../data/repositories/AttendanceRepository.js';
import { StudentsRepository } from '../../data/repositories/StudentsRepository.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const _JWT_SECRET = process.env.JWT_SECRET;

export class ReportsController {
  static async getCasesReport(...args) {
    return await getCasesReport(...args);
  }

  static async getTardanzasReport(...args) {
    return await getTardanzasReport(...args);
  }

  static async getStatsByPeriod(...args) {
    return await getStatsByPeriod(...args);
  }

  static async cronWeeklyReport(...args) {
    return await cronWeeklyReport(...args);
  }

  static async reportAttendance(...args) {
    return await reportAttendance(...args);
  }

  static async reportAttendanceV2(...args) {
    return await reportAttendanceV2(...args);
  }

  static async reportCases(...args) {
    return await reportCases(...args);
  }

  static async getDashboardV2(...args) {
    return await getDashboardV2(...args);
  }

  static isoWeek(...args) {
    return isoWeek(...args);
  }

}

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

  const [casesRes, attRes, studentsRes] = await Promise.all([
    sb.from('raice_cases').select('type, grade, course, status, created_at').gte('created_at', startDate).lte('created_at', endDate + 'T23:59:59'),
    sb.from('raice_attendance').select('status, student_id, date, class_hour').gte('date', startDate).lte('date', endDate),
    sb.from('raice_students').select('id, grade, course').eq('status', 'active')
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

async function getDashboardV2(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb           = getSupabase();
  const today        = todayCO();
  const threeDaysAgo = todayCO(-3);

  // Safe query helper — a failure never kills the whole dashboard
  const safe = async (fn, fallback) => {
    try { return await fn(); } catch (_) { return fallback; }
  };

  const [studentsRes, teachersRes, casesRes, attRes, commitmentsRes, recentCasesRes] = await Promise.all([
    safe(() => sb.from('raice_students').select('id', { count:'exact', head:true }).eq('status','active'), { count:0 }),
    safe(() => sb.from('raice_users').select('id', { count:'exact', head:true }).eq('role','teacher').eq('active',true), { count:0 }),
    safe(() => sb.from('raice_cases').select('id', { count:'exact', head:true }).eq('status','open'), { count:0 }),
    safe(() => sb.from('raice_attendance').select('student_id, status, course_id, class_hour, raice_courses(grade,number)').eq('date', today), { data:[] }),
    safe(() => sb.from('raice_commitments').select('id', { count:'exact', head:true })
      .eq('fulfilled', false).lt('due_date', todayCO(3)), { count:0 }),
    safe(() => sb.from('raice_cases')
      .select('id, student_name, grade, course, type, description, status, created_at, teacher_id')
      .order('created_at', { ascending:false }).limit(8), { data:[] })
  ]);

  // Deduplicate today's attendance (per student + course) keeping the latest hour's status
  const attData = attRes.data || [];
  const studentDedupMap = {};
  attData.forEach(a => {
    if (!a.student_id) return;
    const key = `${a.student_id}_${a.course_id}`;
    if (!studentDedupMap[key] || (a.class_hour || 0) > (studentDedupMap[key].class_hour || 0)) {
      studentDedupMap[key] = a;
    }
  });
  const dedupedAtt = Object.values(studentDedupMap);

  const donutPresent = dedupedAtt.filter(a => a.status === 'P').length;
  const donutAbsent  = dedupedAtt.filter(a => a.status === 'A').length;
  const donutLate    = dedupedAtt.filter(a => a.status === 'T').length;
  const donutPermit  = dedupedAtt.filter(a => a.status === 'PE').length;
  const donutSpecial = dedupedAtt.filter(a => a.status === 'S').length;

  const total = dedupedAtt.length;
  const countable = total - donutPermit - donutSpecial;
  const hasRealList = dedupedAtt.some(a => a.status !== 'PE' && a.status !== 'NR');
  const attPct = hasRealList && countable > 0 ? Math.round(((donutPresent + donutLate) / countable) * 100) : null;

  // Attendance by grade and course
  const gradeMap = {};
  dedupedAtt.forEach(a => {
    const g = a.raice_courses?.grade;
    const n = a.raice_courses?.number || '';
    if (g === undefined || g === null) return;
    const key = n ? `${g}°${n}` : `${g}°`;
    if (!gradeMap[key]) gradeMap[key] = { grade: g, number: n, present: 0, total: 0 };
    gradeMap[key].total++;
    if (['P', 'T', 'PE', 'S'].includes(a.status)) gradeMap[key].present++;
  });
  const att_by_grade = Object.entries(gradeMap)
    .map(([key, v]) => ({ name: key, grade: v.grade, pct: v.total > 0 ? Math.round((v.present / v.total) * 100) : 0 }))
    .sort((a,b) => {
      if (a.grade !== b.grade) return a.grade - b.grade;
      return String(a.name).localeCompare(String(b.name));
    });

  // Alerts — each block independent
  const alerts = [];

  try {
    const r = await sb.rpc('get_repeated_absences', { since_date: threeDaysAgo });
    (r.data || []).forEach(a => alerts.push({
      type:'absence', severity:'medium',
      title:`${a.student_name} — ${a.count} ausencias seguidas`,
      description:`${a.grade}°${a.course} · Última: ${a.last_date}`
    }));
  } catch (_) {}

  try {
    const r = await sb.from('raice_cases')
      .select('id, student_name, type, created_at')
      .eq('status','open').lt('created_at', threeDaysAgo).limit(5);
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
            raice_courses ( grade, number )
          )
        `)
        .eq('day_of_week', dayOfWeek);

      // Traer el horario de timbres y conteo de alumnos
      const [{ data: bells }, { data: studentsAll }, { data: subgroupMembersAll }] = await Promise.all([
        sb.from('raice_bell_schedule').select('class_hour, start_time'),
        sb.from('raice_students').select('course_id').eq('status', 'active'),
        sb.from('raice_subgroup_members').select('subgroup_course_id')
      ]);
      const bellMap = {};
      (bells || []).forEach(b => bellMap[b.class_hour] = b.start_time);

      const studentCountMap = {};
      (studentsAll || []).forEach(s => {
        studentCountMap[s.course_id] = (studentCountMap[s.course_id] || 0) + 1;
      });
      (subgroupMembersAll || []).forEach(m => {
        studentCountMap[m.subgroup_course_id] = (studentCountMap[m.subgroup_course_id] || 0) + 1;
      });

      if (scheds && scheds.length > 0) {
        // Filtrar solo las clases cuya hora de inicio ya es menor a la actual
        const pastScheds = scheds.filter(s => {
           const st = s.start_time || bellMap[s.class_hour];
           return st && st < currentTimeStr;
        });

        // Armar Set de las asistencias ya tomadas HOY
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
          const studentsInCourse = studentCountMap[tc.course_id] || 0;
          if (studentsInCourse === 0) return; // skip empty subgroups/courses!
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
            title: `🚨 ${teacher} — sin llamar lista`,
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
    present:          donutPresent,
    absent:           donutAbsent,
    late:             donutLate,
    permit:           donutPermit,
    commitments_due:  commitmentsRes.count || 0,
    att_by_grade,
    alerts,
    recent_cases: recentCases
  });
}

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

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

function buildStudentRows(st, attRows) {
  return attRows.map(r => ({
    date: r.date,
    class_hour: r.class_hour,
    status: r.status
  })).sort((a,b) => a.date.localeCompare(b.date) || a.class_hour - b.class_hour);
}
