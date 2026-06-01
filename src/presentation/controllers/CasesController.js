import { getSupabase } from '../../data/supabaseClient.js';
import { logActivity, _dbErr, requireRole, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';

function todayCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split('T')[0];
}

export class CasesController {
  static async function handleCases(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100')));
    const offset = (page - 1) * limit;

    let query = sb.from('raice_cases')
      .select('id, student_name, grade, course, type, description, actions_taken, status, created_at, teacher_id', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (user.role === 'teacher') query = query.eq('teacher_id', user.id);

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
  static async function getMyCases(req, res, user) {
  const sb = getSupabase();
  const { data, error } = await sb.from('raice_cases')
    .select('id, student_name, grade, course, type, description, actions_taken, status, created_at, falta_id, falta_numeral, falta_descripcion, falta_categoria, otros_involucrados')
    .eq('teacher_id', user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Error al cargar casos' });
  return res.status(200).json({ cases: data || [] });
}
  static async function getCaseDetail(req, res, user) {
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
  static async function updateCaseStatus(req, res, user) {
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
  static async function saveCaseFollowup(req, res, user) {
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
  static async function handleCommitments(req, res, user) {
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
  static async function fulfillCommitment(req, res, user) {
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
  static async function getStudentHistory(req, res, user) {
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
  static async function getStudentGradeHistory(req, res, user) {
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
  static async function getGradeCases(req, res, user) {
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

}
