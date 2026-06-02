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

export class CoursesController {
  static async handleCourses(...args) {
    return await handleCourses(...args);
  }

  static async handleSubgroupMembers(...args) {
    return await handleSubgroupMembers(...args);
  }

  static async getMyCourses(...args) {
    return await getMyCourses(...args);
  }

  static async handleTeacherCourses(...args) {
    return await handleTeacherCourses(...args);
  }

}

async function handleCourses(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await sb.from('raice_courses')
      .select('id, grade, number, section, director_id, type, name, raice_users(id, first_name, last_name)')
      .order('grade').order('number');
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
    const { grade, number, director_id, type, name } = req.body || {};
    const courseType = type === 'subgroup' ? 'subgroup' : 'normal';

    if (courseType === 'subgroup') {
      requireRole(user, 'superadmin');
      if (!name?.trim()) return res.status(400).json({ error: 'El nombre del subgrupo es requerido' });
      const insertData = { type: 'subgroup', name: name.trim(), director_id: director_id || null };
      if (grade) insertData.grade = parseInt(grade);
      const { data, error } = await sb.from('raice_courses').insert(insertData).select().single();
      if (error) {
        console.error('Error creating subgroup in DB:', error);
        return res.status(500).json({ error: 'Error al crear subgrupo', details: error.message, code: error.code });
      }
      return res.status(200).json({ success: true, course: data });
    }

    if (!grade || !number) return res.status(400).json({ error: 'Grado y número de curso requeridos' });
    const { data, error } = await sb.from('raice_courses').insert({
      grade: parseInt(grade), number: parseInt(number),
      director_id: director_id || null
    }).select().single();
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'Este curso ya existe' : 'Error al crear curso' });
    return res.status(200).json({ success: true, course: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, grade, number, director_id, name } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const { data: crsRow } = await sb.from('raice_courses').select('type').eq('id', id).maybeSingle();
    if (crsRow?.type === 'subgroup') {
      // Subgrupos: solo se puede cambiar nombre y director
      const patch = { director_id: director_id || null };
      if (name?.trim()) patch.name = name.trim();
      const { error } = await sb.from('raice_courses').update(patch).eq('id', id);
      if (error) return res.status(500).json({ error: 'Error al actualizar subgrupo' });
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

async function handleSubgroupMembers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const subgroup_id = url.searchParams.get('subgroup_id');
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
    const { subgroup_id, student_id } = req.body || {};
    if (!subgroup_id || !student_id) return res.status(400).json({ error: 'subgroup_id y student_id requeridos' });
    const { data: crs } = await sb.from('raice_courses').select('type').eq('id', subgroup_id).maybeSingle();
    if (crs?.type !== 'subgroup') return res.status(400).json({ error: 'El curso indicado no es un subgrupo' });
    const { error } = await sb.from('raice_subgroup_members').insert({ subgroup_course_id: subgroup_id, student_id });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'El estudiante ya pertenece a un subgrupo' });
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
      ? sb.from('raice_attendance').select('student_id, status, class_hour, course_id').in('course_id', courseIds).eq('date', today)
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

  // Attendance map: course_id → class_hour → { present, total }
  const attByCourse = {};
  (attAll.data || []).forEach(a => {
    if (!attByCourse[a.course_id]) attByCourse[a.course_id] = {};
    if (!attByCourse[a.course_id][a.class_hour]) attByCourse[a.course_id][a.class_hour] = { present: 0, total: 0 };

    attByCourse[a.course_id][a.class_hour].total++;
    if (a.status === 'P' || a.status === 'PE') attByCourse[a.course_id][a.class_hour].present++;
  });

  const courses = (tc || []).map(row => {
    const c = row.raice_courses;
    if (!c) return null;

    const courseAttMap = attByCourse[c.id] || {};
    const studentsInCourse = studentCountMap[c.id] || 0;

    // An hour is "saved" only if the number of attendance records matches or exceeds students count
    const savedHours = Object.keys(courseAttMap)
      .filter(h => courseAttMap[h].total >= studentsInCourse)
      .map(Number);

    // Per-hour attendance percentage
    const pctByHour = {};
    Object.entries(courseAttMap).forEach(([hour, v]) => {
      pctByHour[Number(hour)] = v.total > 0 ? Math.round((v.present / v.total) * 100) : null;
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
      has_class_today: hasClassToday,
      pending_hours: pendingHours,
      today_slots: todaySlots,
      week_slots: weekSlots,
      suspended_map: suspendedMap  // student_id → suspension for this course's students
    };
  });

  return res.status(200).json({ courses: courses.filter(Boolean) });
}

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

