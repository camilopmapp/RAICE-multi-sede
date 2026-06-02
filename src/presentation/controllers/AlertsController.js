import { getSupabase } from '../../data/supabaseClient.js';
import { requireRole, logActivity, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, _dbErr, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';
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

export class AlertsController {
  static async getAlerts(...args) {
    return await getAlerts(...args);
  }

  static async getAlertsEndpoint(...args) {
    return await getAlertsEndpoint(...args);
  }

  static async handleNotifications(...args) {
    return await handleNotifications(...args);
  }

  static async handleCitations(...args) {
    return await handleCitations(...args);
  }

  static async getEvasions(...args) {
    return await getEvasions(...args);
  }

  static async resolveEvasion(...args) {
    return await resolveEvasion(...args);
  }

  static async handleClassroomRemovals(...args) {
    return await handleClassroomRemovals(...args);
  }

  static async handleSuspensions(...args) {
    return await handleSuspensions(...args);
  }

  static async handleExcusas(...args) {
    return await handleExcusas(...args);
  }

  static async handleCalendar(...args) {
    return await handleCalendar(...args);
  }

  static async handleCalendarRange(...args) {
    return await handleCalendarRange(...args);
  }

  static async handleCalendarToday(...args) {
    return await handleCalendarToday(...args);
  }

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

async function getAlertsEndpoint(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  if (req.method !== 'GET') return res.status(405).end();
  const sb = getSupabase();
  const today        = todayCO();
  const sevenAgo     = todayCO(-7);
  const threeDaysAgo = todayCO(-3);
  const oneDayAgo    = todayCO(-1);

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
      evasion:  { ico: '🏃', label: 'Posible evasión',      severity: 'high'   },
      new_case: { ico: '⚠️', label: 'Nuevo caso RAICE',     severity: 'high'   },
      tardanza: { ico: '⏰', label: 'Tardanza registrada',  severity: 'low'    },
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

  // ── 3. Todos los casos RAICE abiertos ──
  try {
    const { data: openCases } = await sb.from('raice_cases')
      .select('id, student_name, type, created_at, grade, course')
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(10);

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
  try {
    const r = await sb.rpc('get_repeated_absences', { since_date: sevenAgo });
    (r.data || []).forEach(a => alerts.push({
      source: 'computed', type: 'absence', severity: a.count >= 4 ? 'high' : 'medium', ico: '📋',
      title: `${a.student_name} — ${a.count} ausencias en 7 días`,
      description: `${a.grade}°${a.course} · Última falta: ${a.last_date}`
    }));
  } catch (_) {
    // RPC fallback: manual query if function doesn't exist
    try {
      const { data: abRows } = await sb.from('raice_attendance')
        .select('student_id, raice_students(first_name,last_name,grade,course)')
        .eq('status', 'A')
        .gte('date', sevenAgo)
        .limit(200);
      const countMap = {};
      (abRows||[]).forEach(a => {
        const sid = a.student_id;
        if (!countMap[sid]) countMap[sid] = { count:0, stu: a.raice_students };
        countMap[sid].count++;
      });
      Object.values(countMap).filter(v => v.count >= 2 && v.stu).forEach(v => {
        alerts.push({
          source: 'computed', type: 'absence',
          severity: v.count >= 4 ? 'high' : 'medium', ico: '📋',
          title: `${v.stu.first_name} ${v.stu.last_name} — ${v.count} ausencias en 7 días`,
          description: `${v.stu.grade}°${v.stu.course||''}`
        });
      });
    } catch (_) {}
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
            raice_courses ( grade, number )
          )
        `)
        .eq('day_of_week', dayOfWeek);

      const { data: bells } = await sb.from('raice_bell_schedule').select('class_hour, start_time');
      const bellMap = {};
      (bells || []).forEach(b => bellMap[b.class_hour] = b.start_time);

      if (scheds && scheds.length > 0) {
        // Get today's attendance records
        const { data: todayAtt } = await sb.from('raice_attendance')
          .select('course_id, class_hour, status').eq('date', today);
        const takenSet = new Set(
          (todayAtt || [])
            .filter(a => a.status !== 'PE' && a.status !== 'NR')
            .map(a => `${a.course_id}_${a.class_hour}`)
        );

        const pastScheds = scheds.filter(s => {
          const st = s.start_time || bellMap[s.class_hour];
          return st && st < currentTimeStr;
        });

        pastScheds.forEach(s => {
          const tc = s.raice_teacher_courses;
          if (!tc || !tc.course_id || !tc.raice_users || !tc.raice_courses) return;
          if (!takenSet.has(`${tc.course_id}_${s.class_hour}`)) {
            const teacherName = `${tc.raice_users.first_name} ${tc.raice_users.last_name}`;
            const courseName = `${tc.raice_courses.grade}°${tc.raice_courses.number}`;
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
    .in('type', ['evasion', 'evasion_confirmed', 'evasion_dismissed'])
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
    const { error } = await sb.from('raice_suspensions').delete().eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

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
      // Admin listing all: limit to last 100
      query = query.order('created_at', { ascending: false }).limit(100);
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

