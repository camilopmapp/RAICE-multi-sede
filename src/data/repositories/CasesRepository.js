import { getSupabase } from '../supabaseClient';

export class CasesRepository {
  /**
   * Obtiene la lista de casos paginada y aplicando filtros de acceso.
   * Resuelve los nombres de los docentes en memoria.
   */
  static async getAllPaginated(user, page = 1, limit = 100, filterType = null, caseSedeFilter = null) {
    const sb = getSupabase();
    const offset = (page - 1) * limit;

    let query = sb.from('raice_cases')
      .select('id, student_name, grade, course, type, description, actions_taken, status, created_at, teacher_id', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (user.role === 'teacher') {
      query = query.eq('teacher_id', user.id);
    }
    
    if (user.role === 'admin') {
      let adminSedeIds = [];
      if (caseSedeFilter && caseSedeFilter !== 'all') {
        adminSedeIds = [parseInt(caseSedeFilter, 10)];
      } else {
        const { data: userSedes } = await sb.from('raice_user_sedes').select('sede_id').eq('user_id', user.id);
        adminSedeIds = (userSedes || []).map(us => us.sede_id);
      }

      if (adminSedeIds && adminSedeIds.length > 0) {
        const { data: scs } = await sb.from('raice_courses')
          .select('id').in('sede_id', adminSedeIds).neq('type', 'subgroup');
        const cIds = (scs || []).map(c => c.id);
        query = query.in('course_id', cIds.length ? cIds : ['00000000-0000-0000-0000-000000000000']);
      } else {
        query = query.in('course_id', ['00000000-0000-0000-0000-000000000000']);
      }
    }

    if (filterType) {
      query = query.eq('type', parseInt(filterType, 10));
    }

    const { data, error, count } = await query;
    if (error) return { error };

    // Resolve teacher names
    const teacherIds = [...new Set((data || []).map(c => c.teacher_id).filter(Boolean))];
    const teacherMap = {};
    if (teacherIds.length > 0) {
      const { data: teachers } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', teacherIds);
      (teachers || []).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
    }

    const cases = (data || []).map(c => ({
      ...c, teacher_name: teacherMap[c.teacher_id] || '—'
    }));

    return { cases, count: count || 0, error: null };
  }

  /**
   * Crea un nuevo caso de convivencia.
   * Obtiene la información del estudiante para desnormalizar (student_name, grade, course).
   */
  static async createCase(caseParams, userId) {
    const sb = getSupabase();
    
    // Get student info for denormalization
    const { data: student } = await sb.from('raice_students')
      .select('first_name, last_name, grade, course').eq('id', caseParams.student_id).single();

    const casePayload = {
      student_id: caseParams.student_id,
      course_id: caseParams.course_id,
      student_name: student ? `${student.first_name} ${student.last_name}` : 'Desconocido',
      grade: student?.grade,
      course: student?.course,
      teacher_id: userId,
      type: caseParams.type,
      description: caseParams.description,
      actions_taken: caseParams.actions_taken,
      notes: caseParams.notes,
      falta_id: caseParams.falta_id || null,
      falta_numeral: caseParams.falta_numeral || null,
      falta_descripcion: caseParams.falta_descripcion || null,
      falta_categoria: caseParams.falta_categoria || null,
      otros_involucrados: caseParams.otros_involucrados || null,
      status: 'open'
    };

    const { data: caseData, error } = await sb.from('raice_cases').insert(casePayload).select().single();

    return { caseData, student, error };
  }
}
