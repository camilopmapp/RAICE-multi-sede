export function requireRole(user, ...roles) {
  // Rector inherits admin read access — expand role list automatically
  const effective = roles.includes('admin') && !roles.includes('rector')
    ? [...roles, 'rector']
    : roles;
  if (!effective.includes(user.role)) throw { status: 403, message: 'No tienes permiso para esta acción' };
}

export async function getAdminSedeIds(sb, user, sedeFilter = null) {
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

export async function logActivity(sb, userId, type, detail) {
  try {
    await sb.from('raice_logs').insert({ user_id: userId, event_type: type, detail });
  } catch (_) { /* silencioso */ }
}

export async function sendNotification(sb, toUserId, fromUserId, type, title, body, linkId = null) {
  const { error } = await sb.from('raice_notifications').insert({
    to_user_id: toUserId, from_user_id: fromUserId, type, title, body, link_id: linkId
  });
  if (error) console.error('[RAICE Notification]', error.message, { toUserId, type });
}

export async function reevaluateEvasions(sb, courseId, date, studentIds) {
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

export function _dbErr(error, defaultMsg = 'Error en base de datos') {
  if (!error) return defaultMsg;
  console.error('[DB ERROR]', error);
  if (error.code === '23505') return 'El registro ya existe (duplicado)';
  if (error.code === '23503') return 'El registro está siendo usado por otros datos y no se puede alterar';
  return error.message || defaultMsg;
}

export async function getAllowedCourseIdsForAdmin(sb, user, sedeFilter = null) {
  if (user.role !== 'admin') return null;
  const adminSedeIds = await getAdminSedeIds(sb, user, sedeFilter);
  if (!adminSedeIds || adminSedeIds.length === 0) return ['00000000-0000-0000-0000-000000000000'];
  const { data: courses } = await sb.from('raice_courses').select('id').in('sede_id', adminSedeIds);
  const ids = (courses || []).map(c => c.id);
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'];
}
