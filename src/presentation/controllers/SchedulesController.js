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

export class SchedulesController {
  static async handleSchedules(...args) {
    return await handleSchedules(...args);
  }

  static async getTeacherSchedule(...args) {
    return await getTeacherSchedule(...args);
  }

  static async handleTeacherAbsences(...args) {
    return await handleTeacherAbsences(...args);
  }

  static async handleAbsenceReplacement(...args) {
    return await handleAbsenceReplacement(...args);
  }

  static async getReplacementSuggestions(...args) {
    return await getReplacementSuggestions(...args);
  }

  static async getSchedulesOverview(...args) {
    return await getSchedulesOverview(...args);
  }

}

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

async function getTeacherSchedule(req, res, user) {
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Teachers can only see their own schedule; admins/superadmins can query any teacher_id
  let teacherId;
  if (['superadmin', 'admin'].includes(user.role)) {
    teacherId = url.searchParams.get('teacher_id') || user.id;
  } else {
    teacherId = user.id; // teachers always see only their own schedule
  }

  const { data: tc } = await sb.from('raice_teacher_courses')
    .select('id, subject, course_id, raice_courses(grade, number, section)')
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
      return {
        ...s,
        subject:    row.subject || '—',
        grade:      c.grade,
        course_num: c.number,
        section:    c.section || String(c.number || 1),
        course_id:  row.course_id
      };
    });
  }

  const { data: bell } = await sb.from('raice_bell_schedule')
    .select('*').order('class_hour');

  return res.status(200).json({ schedules, bell_schedule: bell || [] });
}

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

async function getSchedulesOverview(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb = getSupabase();

  try {
    const today = todayCO();
    const todayDow = dayOfWeekCO(today);

    // 1. Fetch today's attendance to see which classes are already taken
    const { data: todayAtt, error: attErr } = await sb
      .from('raice_attendance')
      .select('course_id, class_hour, status')
      .eq('date', today);
    if (attErr) return res.status(500).json({ error: _dbErr(attErr, 'overview attendance') });

    const takenSet = new Set(
      (todayAtt || [])
        .filter(a => a.status !== 'PE' && a.status !== 'NR')
        .map(a => `${a.course_id}_${a.class_hour}`)
    );

    // 2. Fetch all schedules with course, teacher, and user details
    const { data: schedRows, error: schedErr } = await sb
      .from('raice_schedules')
      .select(`
        id,
        day_of_week,
        class_hour,
        start_time,
        end_time,
        teacher_course_id,
        raice_teacher_courses (
          subject,
          teacher_id,
          course_id,
          raice_users ( id, first_name, last_name ),
          raice_courses ( id, grade, number, section, type, name )
        )
      `);
    if (schedErr) return res.status(500).json({ error: _dbErr(schedErr, 'overview schedules') });

    // Format to the flat structure the frontend expects
    const schedules = (schedRows || []).map(s => {
      const tc = s.raice_teacher_courses || {};
      const u  = tc.raice_users || {};
      const c  = tc.raice_courses || {};
      const courseId = tc.course_id;
      const classHour = s.class_hour;
      const attendance_taken = takenSet.has(`${courseId}_${classHour}`);
      return {
        id: s.id,
        day_of_week: s.day_of_week,
        class_hour: classHour,
        start_time: s.start_time,
        end_time: s.end_time,
        teacher_course_id: s.teacher_course_id,
        subject: tc.subject || '—',
        teacher_id: tc.teacher_id,
        teacher_name: u.first_name ? `${u.first_name} ${u.last_name}` : '—',
        course_id: courseId,
        grade: c.grade,
        number: c.number,
        section: c.section || String(c.number || 1),
        type: c.type || 'regular',
        course_name: c.name || '',
        attendance_taken
      };
    });

    // 3. Fetch the bell schedule
    const { data: bell, error: bellErr } = await sb
      .from('raice_bell_schedule')
      .select('*')
      .order('class_hour');
    if (bellErr) return res.status(500).json({ error: _dbErr(bellErr, 'overview bell') });

    return res.status(200).json({
      schedules,
      bell_schedule: bell || [],
      today_dow: todayDow
    });
  } catch (err) {
    console.error('getSchedulesOverview error:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

