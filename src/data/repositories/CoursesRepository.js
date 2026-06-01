import { getSupabase } from '../supabaseClient';
import { getAdminSedeIds } from '../../../pages/api/[...path]';

export class CoursesRepository {
  /**
   * Obtiene la lista completa de cursos con información enriquecida (cantidad de estudiantes, docentes asignados).
   */
  static async getAllCoursesEnriched(user) {
    const sb = getSupabase();
    
    let coursesQ = sb.from('raice_courses')
      .select('id, grade, number, section, director_id, type, name, sede_id, raice_users(id, first_name, last_name)')
      .order('grade').order('number');

    if (user.role === 'admin') {
      // Usar BD directa para admin (evita JWT desactualizado)
      const { data: userSedes } = await sb.from('raice_user_sedes').select('sede_id').eq('user_id', user.id);
      const adminSedeIds = (userSedes || []).map(us => us.sede_id);
      
      if (adminSedeIds && adminSedeIds.length > 0) {
        coursesQ = coursesQ.in('sede_id', adminSedeIds);
      } else {
        coursesQ = coursesQ.in('sede_id', ['00000000-0000-0000-0000-000000000000']);
      }
    }

    const { data, error } = await coursesQ;
    if (error) return { error: 'Error al cargar cursos' };

    const courseIds   = (data || []).map(c => c.id);
    const normalIds   = (data || []).filter(c => c.type !== 'subgroup').map(c => c.id);
    const subgroupIds = (data || []).filter(c => c.type === 'subgroup').map(c => c.id);

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

    return { courses, error: null };
  }

  static async createCourse(params, user) {
    const sb = getSupabase();
    const { grade, number, director_id, type, name, sede_id: courseSede } = params;
    const courseType = type === 'subgroup' ? 'subgroup' : 'normal';
    const effectiveSede = user.role === 'superadmin'
      ? (courseSede || null)
      : (user.sede_id || (user.sede_ids && user.sede_ids[0]) || null);

    if (courseType === 'subgroup') {
      if (user.role !== 'superadmin') return { error: 'No autorizado', status: 403 };
      if (!name?.trim()) return { error: 'El nombre del subgrupo es requerido', status: 400 };
      const insertData = { type: 'subgroup', name: name.trim(), director_id: director_id || null, sede_id: effectiveSede };
      if (grade) insertData.grade = parseInt(grade);
      
      const { data, error } = await sb.from('raice_courses').insert(insertData).select().single();
      if (error) return { error: 'Error al crear subgrupo', detail: error.message, hint: error.hint, status: 500 };
      return { course: data };
    }

    if (!grade || !number) return { error: 'Grado y número de curso requeridos', status: 400 };
    const { data, error } = await sb.from('raice_courses').insert({
      grade: parseInt(grade), number: parseInt(number),
      director_id: director_id || null, sede_id: effectiveSede
    }).select().single();
    
    if (error) return { error: error.code === '23505' ? 'Este curso ya existe en esa sede' : 'Error al crear curso', status: 500 };
    return { course: data };
  }

  static async updateCourse(params, user) {
    const sb = getSupabase();
    const { id, grade, number, director_id, name } = params;
    if (!id) return { error: 'ID requerido', status: 400 };
    
    const { data: crsRow } = await sb.from('raice_courses').select('type').eq('id', id).maybeSingle();
    
    if (crsRow?.type === 'subgroup') {
      const { sede_id: subgroupSede } = params;
      const patch = { director_id: director_id || null };
      if (name?.trim()) patch.name = name.trim();
      if (subgroupSede) patch.sede_id = subgroupSede;
      if ('grade' in params) patch.grade = (grade != null && grade !== '') ? parseInt(grade) : null;
      
      const { data: updatedRow, error } = await sb.from('raice_courses').update(patch).eq('id', id).select('id, name, grade, sede_id').single();
      if (error) return { error: 'Error al actualizar subgrupo', detail: error.message, status: 500 };
      return { course: updatedRow, patch_sent: patch };
    } else {
      const { error } = await sb.from('raice_courses').update({
        grade: parseInt(grade), number: parseInt(number), director_id: director_id || null
      }).eq('id', id);
      if (error) return { error: 'Error al actualizar curso', status: 500 };
      return { success: true };
    }
  }

  static async deleteCourse(id, user) {
    const sb = getSupabase();
    if (!id) return { error: 'ID requerido', status: 400 };
    if (user.role !== 'superadmin') return { error: 'No autorizado', status: 403 };
    
    const { error } = await sb.from('raice_courses').delete().eq('id', id);
    if (error) return { error: 'Error al eliminar curso', status: 500 };
    return { success: true };
  }
}
