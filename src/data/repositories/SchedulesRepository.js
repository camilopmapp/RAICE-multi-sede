import { getSupabase } from '../supabaseClient';

export class SchedulesRepository {
  /**
   * Obtiene todos los horarios asociados a un teacher_course_id o a un course_id completo.
   */
  static async getSchedules({ tcId, courseId }) {
    const sb = getSupabase();

    if (tcId) {
      const { data, error } = await sb.from('raice_schedules').select('*')
        .eq('teacher_course_id', tcId).order('day_of_week').order('class_hour');
      if (error) return { error: 'Error al obtener horario', status: 500 };
      return { schedules: data || [] };
    }

    if (courseId) {
      const { data: tcRows, error: tcErr } = await sb.from('raice_teacher_courses')
        .select('id, subject, teacher_id, raice_users(first_name, last_name)')
        .eq('course_id', courseId);
      if (tcErr) return { error: 'Error al obtener docentes', status: 500 };

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
      return { schedules, teachers: tcRows || [] };
    }

    return { error: 'teacher_course_id o course_id requerido', status: 400 };
  }

  /**
   * Crea o actualiza un horario validando que no existan cruces.
   */
  static async upsertSchedule(params) {
    const sb = getSupabase();
    const { teacher_course_id, day_of_week, class_hour, start_time, end_time } = params;

    const { data: tcInfo } = await sb.from('raice_teacher_courses')
      .select('teacher_id, course_id, subject, raice_users(first_name, last_name)')
      .eq('id', teacher_course_id).single();
    if (!tcInfo) return { error: 'Asignación docente/materia no encontrada', status: 400 };

    // ── 1. Conflict check: COURSE slot already taken ──
    const { data: sameCourseTC } = await sb.from('raice_teacher_courses')
      .select('id').eq('course_id', tcInfo.course_id);
    const sameCourseIds = (sameCourseTC || []).map(r => r.id);

    if (sameCourseIds.length) {
      const { data: courseConflict } = await sb.from('raice_schedules')
        .select('id, teacher_course_id')
        .in('teacher_course_id', sameCourseIds)
        .eq('day_of_week', day_of_week)
        .eq('class_hour', class_hour);

      const realCourseConflict = (courseConflict || []).filter(r => r.teacher_course_id !== teacher_course_id);
      if (realCourseConflict.length) {
        const conflictTcId = realCourseConflict[0].teacher_course_id;
        const { data: conflictTC } = await sb.from('raice_teacher_courses')
          .select('subject, raice_users(first_name, last_name)')
          .eq('id', conflictTcId).single();
        const cName = conflictTC?.raice_users ? `${conflictTC.raice_users.first_name} ${conflictTC.raice_users.last_name}` : 'otro docente';
        const cSubj = conflictTC?.subject || 'otra materia';
        const dayNames = {1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes'};
        return {
          error: `⚠️ Cruce de horario en el curso: el ${dayNames[day_of_week]} a la ${class_hour}ª hora ya está asignado a "${cSubj}" con ${cName}.`,
          status: 409
        };
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

      const realTeacherConflict = (teacherConflict || []).filter(r =>
        r.teacher_course_id !== teacher_course_id &&
        !(sameCourseIds.includes(r.teacher_course_id))
      );
      if (realTeacherConflict.length) {
        const conflictTcId = realTeacherConflict[0].teacher_course_id;
        const conflictTCInfo = (sameTeacherTC || []).find(r => r.id === conflictTcId);
        const { data: conflictCourse } = await sb.from('raice_courses')
          .select('grade, number').eq('id', conflictTCInfo?.course_id).single();
        const courseLabel = conflictCourse ? `${conflictCourse.grade}°${conflictCourse.number}` : 'otro curso';
        const tName = tcInfo.raice_users ? `${tcInfo.raice_users.first_name} ${tcInfo.raice_users.last_name}` : 'El docente';
        const dayNames = {1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes'};
        return {
          error: `⚠️ Cruce de horario del docente: ${tName} ya tiene "${conflictTCInfo?.subject || 'otra materia'}" en ${courseLabel} el ${dayNames[day_of_week]} a la ${class_hour}ª hora.`,
          status: 409
        };
      }
    }

    const { error } = await sb.from('raice_schedules').upsert({
      teacher_course_id, day_of_week, class_hour,
      start_time: start_time || null, end_time: end_time || null
    }, { onConflict: 'teacher_course_id,day_of_week,class_hour' });

    if (error) return { error: error.message || 'Error al guardar horario', status: 500 };
    return { success: true };
  }

  static async deleteSchedule(id) {
    const sb = getSupabase();
    if (!id) return { error: 'ID requerido', status: 400 };
    await sb.from('raice_schedules').delete().eq('id', id);
    return { success: true };
  }
}
