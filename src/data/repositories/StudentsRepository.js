import { getSupabase } from '../supabaseClient';
import { getAdminSedeIds } from '../../../pages/api/[...path]';

export class StudentsRepository {
  /**
   * Obtiene todos los estudiantes aplicando filtros de acceso según el rol del usuario.
   * Utiliza la lógica original del router para mantener la paridad funcional.
   */
  static async getFilteredForUser(user, courseId, stuSedeFilter) {
    const sb = getSupabase();
    let query = sb.from('raice_students')
      .select('id, first_name, last_name, grade, course, course_id, doc_type, doc_number, birth_date, phone, status, notes')
      .order('grade').order('course').order('last_name');

    const isAdmin = ['superadmin', 'admin', 'rector'].includes(user.role);

    // Teachers always see only active students; admins see all by default
    if (!isAdmin) query = query.eq('status', 'active');

    if (courseId) {
      // Teachers can only access their own courses — validate access
      if (!isAdmin) {
        const { data: tcCheck } = await sb.from('raice_teacher_courses')
          .select('id').eq('teacher_id', user.id).eq('course_id', courseId).limit(1);
        if (!tcCheck || !tcCheck.length) return { error: 'No tienes acceso a este curso' };
      }
      query = query.eq('course_id', courseId);
    } else if (!isAdmin) {
      // Teacher: only their assigned courses
      const { data: teacherCourses } = await sb.from('raice_teacher_courses')
        .select('course_id').eq('teacher_id', user.id);
      const ids = (teacherCourses || []).map(tc => tc.course_id);
      if (ids.length) query = query.in('course_id', ids);
      else return { data: [] };
    } else if (user.role === 'admin') {
      // Import getAdminSedeIds inside function to avoid circular dependency issues, or duplicate simple logic
      // For now, we will duplicate the simple getAdminSedeIds logic since importing it from api route is tricky
      let adminSedeIds = [];
      if (stuSedeFilter && stuSedeFilter !== 'all') {
        adminSedeIds = [parseInt(stuSedeFilter, 10)];
      } else {
        const { data: userSedes } = await sb.from('raice_user_sedes').select('sede_id').eq('user_id', user.id);
        adminSedeIds = (userSedes || []).map(us => us.sede_id);
      }
      
      if (adminSedeIds && adminSedeIds.length > 0) {
        const { data: sedeCourses } = await sb.from('raice_courses')
          .select('id').in('sede_id', adminSedeIds).neq('type', 'subgroup');
        const ids = (sedeCourses || []).map(c => c.id);
        if (ids.length) query = query.in('course_id', ids);
        else return { data: [] };
      } else {
        return { data: [] };
      }
    }

    return await query;
  }

  /**
   * Enriquece la data de estudiantes con el conteo de casos, porcentaje de asistencia y sede.
   * Ejecuta queries sin `.in()` para evitar límites de URL de PostgREST.
   */
  static async enrichStudentsData(students) {
    if (!students || !students.length) return [];
    const sb = getSupabase();
    
    // YYYY-MM-01 in Colombia time
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const monthStart = today.substring(0, 8) + '01'; 
    const studentIds = students.map(s => s.id);
    const studentIdSet = new Set(studentIds);

    const [casesRes, attRes, coursesRes, sedesRes] = await Promise.all([
      sb.from('raice_cases').select('student_id'),
      sb.from('raice_attendance')
        .select('student_id, status')
        .gte('date', monthStart),
      sb.from('raice_courses').select('id, name, type, sede_id'),
      sb.from('raice_sedes').select('id, name')
    ]);

    const casesMap = {};
    (casesRes.data || []).forEach(c => {
      if (!studentIdSet.has(c.student_id)) return;
      casesMap[c.student_id] = (casesMap[c.student_id] || 0) + 1;
    });

    const attMap = {};
    (attRes.data || []).forEach(a => {
      if (!studentIdSet.has(a.student_id)) return;
      if (!attMap[a.student_id]) attMap[a.student_id] = { total: 0, present: 0 };
      attMap[a.student_id].total++;
      if (a.status === 'P' || a.status === 'PE') attMap[a.student_id].present++;
    });

    const coursesMap = {};
    (coursesRes.data || []).forEach(c => {
      coursesMap[c.id] = c;
    });

    const sedesMap = {};
    (sedesRes.data || []).forEach(s => {
      sedesMap[s.id] = s.name;
    });

    return students.map(s => {
      const courseObj = coursesMap[s.course_id] || {};
      const sedeName = sedesMap[courseObj.sede_id] || null;
      return {
        ...s,
        sede_id: courseObj.sede_id || null,
        sede_name: sedeName,
        cases_count: casesMap[s.id] || 0,
        att_pct: attMap[s.id] && attMap[s.id].total > 0
          ? Math.round((attMap[s.id].present / attMap[s.id].total) * 100)
          : null
      };
    });
  }

  // --- MÉTODOS BÁSICOS EXTRAÍDOS PREVIAMENTE ---
  static async getById(id) {
    const sb = getSupabase();
    const { data, error } = await sb.from('raice_students').select('*').eq('id', id).single();
    return { student: data, error };
  }
}
