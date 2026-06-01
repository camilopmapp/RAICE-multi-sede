import { getSupabase } from '../../data/supabaseClient.js';
import { logActivity, _dbErr, requireRole } from '../../shared/utils/apiHelpers.js';

export class StudentsController {
  static async function handleStudents(req, res, user) {
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

  static async function importStudents(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();

  const sb = getSupabase();
  const { students } = req.body || {};
  if (!Array.isArray(students) || !students.length) return res.status(400).json({ error: 'No hay estudiantes para importar' });

  let imported = 0, updated = 0, skipped = 0, errors = [];

  for (const s of students) {
    if (!s.first_name || !s.last_name || !s.grade) { skipped++; continue; }

    // Find or create course
    let courseId = null;
    const { data: courseData } = await sb.from('raice_courses')
      .select('id').eq('grade', parseInt(s.grade)).eq('number', parseInt(s.course) || 1).single();
    if (courseData) {
      courseId = courseData.id;
    } else {
      // Auto-create course
      const { data: newCourse } = await sb.from('raice_courses').insert({
        grade: parseInt(s.grade), number: parseInt(s.course) || 1
      }).select().single();
      if (newCourse) courseId = newCourse.id;
    }

    // Check for duplicate
    const { data: existing } = await sb.from('raice_students')
      .select('id').eq('first_name', s.first_name.trim()).eq('last_name', s.last_name.trim())
      .eq('grade', parseInt(s.grade)).eq('course', parseInt(s.course) || 1).single();

    if (existing) {
      // Update only the fields that come in the Excel (overwrite with new values)
      const patch = {};
      if (s.doc_type)   patch.doc_type   = s.doc_type;
      if (s.doc_number) patch.doc_number = s.doc_number;
      if (s.birth_date) patch.birth_date = s.birth_date;
      if (s.phone)      patch.phone      = s.phone;
      if (Object.keys(patch).length) {
        const { error: ue } = await sb.from('raice_students').update(patch).eq('id', existing.id);
        if (ue) errors.push(`${s.first_name} ${s.last_name}: ${ue.message}`);
        else updated++;
      } else {
        skipped++;
      }
      continue;
    }

    // Generate unique code
    const code = `${String(s.grade).padStart(2,'0')}${String(s.course||1).padStart(2,'0')}${String(imported+1).padStart(3,'0')}`;

    const { error } = await sb.from('raice_students').insert({
      first_name: s.first_name.trim(),
      last_name:  s.last_name.trim(),
      grade:      parseInt(s.grade),
      course:     parseInt(s.course) || 1,
      course_id:  courseId,
      doc_type:   s.doc_type   || 'TI',
      doc_number: s.doc_number || null,
      birth_date: s.birth_date || null,
      phone:      s.phone      || null,
      code,
      status: 'active'
    });

    if (error) { errors.push(`${s.first_name} ${s.last_name}: ${error.message}`); }
    else imported++;
  }

  await logActivity(sb, user.id, 'import_students', `${imported} creados, ${updated} actualizados`);
  return res.status(200).json({ success: true, imported, updated, skipped, errors: errors.slice(0, 5) });
}

  static async function _createSimatStudent(sb, s) {
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

  static async function simatPreview(req, res, user) {
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

  static async function simatImport(req, res, user) {
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

  static async function getStudentFicha(req, res, user) {
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const studentId = url.searchParams.get('id');
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
    safe(() => sb.from('raice_cases').select('id, type, description, status, created_at').eq('student_id', studentId).order('created_at', { ascending: false })),
    safe(() => sb.from('raice_observations').select('id, type, text, created_at, teacher_id').eq('student_id', studentId).order('created_at', { ascending: false }).limit(20)),
    safe(() => sb.from('raice_attendance').select('status, date, class_hour').eq('student_id', studentId).order('date', { ascending: false }).limit(90)),
    safe(() => sb.from('raice_attendance').select('date, class_hour').eq('student_id', studentId).eq('status','T').order('date', { ascending: false }).limit(20)),
    safe(() => sb.from('raice_commitments').select('description, due_date, fulfilled').eq('student_id', studentId).order('created_at', { ascending: false }))
  ]);

  if (!studentRes.data) return res.status(404).json({ error: 'Estudiante no encontrado' });

  // Fetch acudientes separately — table may not exist yet
  let acudientes = [];
  try {
    const { data: acudData } = await sb.from('raice_acudientes').select('*').eq('student_id', studentId).limit(5);
    acudientes = acudData || [];
  } catch (_) {}

  // Resolve observation teacher names separately (avoids FK name issues)
  const obsData = obsRes.data || [];
  const teacherIds = [...new Set(obsData.map(o => o.teacher_id).filter(Boolean))];
  const tMap = {};
  if (teacherIds.length) {
    const { data: teachers } = await sb.from('raice_users').select('id, first_name, last_name').in('id', teacherIds);
    (teachers || []).forEach(t => tMap[t.id] = `${t.first_name} ${t.last_name}`);
  }
  const obs = obsData.map(o => ({ ...o, teacher_name: tMap[o.teacher_id] || '—' }));

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
    cases:        casesRes.data  || [],
    observations: obs,
    attendance:   { pct: attPct, present: cntP, permit: cntPE, absent: cntA, late: cntT, special: cntS, total: total, recent: recentAtt },
    tardanzas:    tardanzasRes.data || [],
    commitments:  commitmentsRes.data || [],
    acudientes
  });
}


  static async function importStudents(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();

  const sb = getSupabase();
  const { students } = req.body || {};
  if (!Array.isArray(students) || !students.length) return res.status(400).json({ error: 'No hay estudiantes para importar' });

  let imported = 0, updated = 0, skipped = 0, errors = [];

  for (const s of students) {
    if (!s.first_name || !s.last_name || !s.grade) { skipped++; continue; }

    // Find or create course
    let courseId = null;
    const { data: courseData } = await sb.from('raice_courses')
      .select('id').eq('grade', parseInt(s.grade)).eq('number', parseInt(s.course) || 1).single();
    if (courseData) {
      courseId = courseData.id;
    } else {
      // Auto-create course
      const { data: newCourse } = await sb.from('raice_courses').insert({
        grade: parseInt(s.grade), number: parseInt(s.course) || 1
      }).select().single();
      if (newCourse) courseId = newCourse.id;
    }

    // Check for duplicate
    const { data: existing } = await sb.from('raice_students')
      .select('id').eq('first_name', s.first_name.trim()).eq('last_name', s.last_name.trim())
      .eq('grade', parseInt(s.grade)).eq('course', parseInt(s.course) || 1).single();

    if (existing) {
      // Update only the fields that come in the Excel (overwrite with new values)
      const patch = {};
      if (s.doc_type)   patch.doc_type   = s.doc_type;
      if (s.doc_number) patch.doc_number = s.doc_number;
      if (s.birth_date) patch.birth_date = s.birth_date;
      if (s.phone)      patch.phone      = s.phone;
      if (Object.keys(patch).length) {
        const { error: ue } = await sb.from('raice_students').update(patch).eq('id', existing.id);
        if (ue) errors.push(`${s.first_name} ${s.last_name}: ${ue.message}`);
        else updated++;
      } else {
        skipped++;
      }
      continue;
    }

    // Generate unique code
    const code = `${String(s.grade).padStart(2,'0')}${String(s.course||1).padStart(2,'0')}${String(imported+1).padStart(3,'0')}`;

    const { error } = await sb.from('raice_students').insert({
      first_name: s.first_name.trim(),
      last_name:  s.last_name.trim(),
      grade:      parseInt(s.grade),
      course:     parseInt(s.course) || 1,
      course_id:  courseId,
      doc_type:   s.doc_type   || 'TI',
      doc_number: s.doc_number || null,
      birth_date: s.birth_date || null,
      phone:      s.phone      || null,
      code,
      status: 'active'
    });

    if (error) { errors.push(`${s.first_name} ${s.last_name}: ${error.message}`); }
    else imported++;
  }

  await logActivity(sb, user.id, 'import_students', `${imported} creados, ${updated} actualizados`);
  return res.status(200).json({ success: true, imported, updated, skipped, errors: errors.slice(0, 5) });
}

  static async function _createSimatStudent(sb, s) {
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

  static async function simatPreview(req, res, user) {
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

  static async function simatImport(req, res, user) {
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

  static async function getStudentFicha(req, res, user) {
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const studentId = url.searchParams.get('id');
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
    safe(() => sb.from('raice_cases').select('id, type, description, status, created_at').eq('student_id', studentId).order('created_at', { ascending: false })),
    safe(() => sb.from('raice_observations').select('id, type, text, created_at, teacher_id').eq('student_id', studentId).order('created_at', { ascending: false }).limit(20)),
    safe(() => sb.from('raice_attendance').select('status, date, class_hour').eq('student_id', studentId).order('date', { ascending: false }).limit(90)),
    safe(() => sb.from('raice_attendance').select('date, class_hour').eq('student_id', studentId).eq('status','T').order('date', { ascending: false }).limit(20)),
    safe(() => sb.from('raice_commitments').select('description, due_date, fulfilled').eq('student_id', studentId).order('created_at', { ascending: false }))
  ]);

  if (!studentRes.data) return res.status(404).json({ error: 'Estudiante no encontrado' });

  // Fetch acudientes separately — table may not exist yet
  let acudientes = [];
  try {
    const { data: acudData } = await sb.from('raice_acudientes').select('*').eq('student_id', studentId).limit(5);
    acudientes = acudData || [];
  } catch (_) {}

  // Resolve observation teacher names separately (avoids FK name issues)
  const obsData = obsRes.data || [];
  const teacherIds = [...new Set(obsData.map(o => o.teacher_id).filter(Boolean))];
  const tMap = {};
  if (teacherIds.length) {
    const { data: teachers } = await sb.from('raice_users').select('id, first_name, last_name').in('id', teacherIds);
    (teachers || []).forEach(t => tMap[t.id] = `${t.first_name} ${t.last_name}`);
  }
  const obs = obsData.map(o => ({ ...o, teacher_name: tMap[o.teacher_id] || '—' }));

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
    cases:        casesRes.data  || [],
    observations: obs,
    attendance:   { pct: attPct, present: cntP, permit: cntPE, absent: cntA, late: cntT, special: cntS, total: total, recent: recentAtt },
    tardanzas:    tardanzasRes.data || [],
    commitments:  commitmentsRes.data || [],
    acudientes
  });
}

}
