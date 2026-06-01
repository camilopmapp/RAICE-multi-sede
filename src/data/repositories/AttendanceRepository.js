import { getSupabase } from '../supabaseClient';

export class AttendanceRepository {
  /**
   * Elimina registros de asistencia para una clase específica.
   */
  static async deleteRecords(courseId, date, hour) {
    const sb = getSupabase();
    const res = await sb.from('raice_attendance').delete()
      .eq('course_id', courseId).eq('date', date).eq('class_hour', hour);
      
    if (res.error && res.error.message.includes('class_hour')) {
      // Fallback si la columna class_hour no existe
      return await sb.from('raice_attendance').delete().eq('course_id', courseId).eq('date', date);
    }
    return res;
  }

  /**
   * Guarda registros de asistencia.
   */
  static async insertRecords(rows) {
    const sb = getSupabase();
    let res = await sb.from('raice_attendance').insert(rows);
    
    if (res.error && res.error.message.includes('activity_note')) {
      const rowsNoNote = rows.map(r => { const { activity_note: _, ...rest } = r; return rest; });
      res = await sb.from('raice_attendance').insert(rowsNoNote);
    }
    
    if (res.error && (res.error.message.includes('class_hour') || res.error.message.includes('status'))) {
      const fallbackRows = rows.map(r => ({
        student_id: r.student_id,
        course_id: r.course_id,
        teacher_id: r.teacher_id,
        date: r.date,
        status: r.status === 'T' ? 'PE' : (['P','A','PE'].includes(r.status) ? r.status : 'P')
      }));
      res = await sb.from('raice_attendance').insert(fallbackRows);
    }
    return res;
  }
}
