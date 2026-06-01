import { getSupabase } from '../../data/supabaseClient';
import { dayOfWeekCO, todayCO } from '../../shared/utils/date';
import { AttendanceRepository } from '../../data/repositories/AttendanceRepository';

export class RegisterAttendanceUseCase {
  static async execute(params, user, { sendNotificationFn, logActivityFn, reevaluateEvasionsFn }) {
    const sb = getSupabase();
    const { course_id, date, class_hour, records, activity_note } = params;
    const hour = parseInt(class_hour) || 1;

    // Validate that this teacher is assigned to this course
    if (user.role === 'teacher') {
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id').eq('teacher_id', user.id).eq('course_id', course_id);
      if (!tcRows || !tcRows.length) {
        return { error: 'No tienes acceso a este curso', status: 403 };
      }
      
      try {
        const tcIds     = tcRows.map(r => r.id);
        const dayOfWeek = dayOfWeekCO(date);

        const { data: schedRows, error: schedErr } = await sb.from('raice_schedules')
          .select('class_hour').in('teacher_course_id', tcIds).eq('day_of_week', dayOfWeek);

        if (!schedErr) {
          const scheduledHours = (schedRows || []).map(s => s.class_hour);
          if (scheduledHours.length === 0) {
            const { data: anyRows } = await sb.from('raice_schedules')
              .select('id').in('teacher_course_id', tcIds).limit(1);
            if (anyRows && anyRows.length > 0) {
              return { error: 'Este docente no tiene clase hoy con este curso según el horario configurado.', status: 403 };
            }
          } else if (!scheduledHours.includes(hour)) {
            return { error: `No tienes clase en la ${hour}ª hora con este curso`, status: 403 };
          }
        }
      } catch (_) { /* tabla no disponible, permitir guardado */ }

      const today = todayCO();
      if (date !== today) {
        return { error: 'Solo puedes registrar asistencia del día actual.', status: 423 };
      }

      const { data: existingRec } = await sb.from('raice_attendance')
        .select('id, teacher_id, created_at')
        .eq('course_id', course_id).eq('date', date).eq('class_hour', hour)
        .limit(1).maybeSingle();
      
      if (existingRec) {
        if (existingRec.teacher_id !== user.id) {
          return { error: 'Esta asistencia fue registrada por otro docente. Solo el coordinador puede corregirla.', status: 403 };
        }
        
        const { data: cfgData } = await sb.from('raice_config')
          .select('correction_window, correction_window_minutes, correction_window_hour')
          .eq('id', 1).maybeSingle();
          
        const windowType    = cfgData?.correction_window         || 'same_day_end';
        const windowMinutes = cfgData?.correction_window_minutes || 55;
        const windowHour    = cfgData?.correction_window_hour    || '23:59';
        let deadline;
        
        if (windowType === 'class_duration') {
          const { data: bellRow } = await sb.from('raice_bell_schedule')
            .select('end_time').eq('class_hour', hour).maybeSingle();
          if (bellRow?.end_time) {
            const [ch, cm] = bellRow.end_time.split(':');
            deadline = new Date(`${date}T${String(parseInt(ch)).padStart(2,'0')}:${String(parseInt(cm)).padStart(2,'0')}:00.000Z`);
            deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
          } else {
            deadline = new Date(new Date(existingRec.created_at).getTime() + windowMinutes * 60000);
          }
        } else if (windowType === 'same_day_hour') {
          const wh = String(windowHour || '23:59').padStart(5, '0');
          const [wHH, wMM] = wh.split(':').map(Number);
          deadline = new Date(`${date}T${String(wHH).padStart(2,'0')}:${String(wMM).padStart(2,'0')}:00.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else if (windowType === 'next_day_end') {
          const nextDay = (() => {
            const d = new Date(date + 'T12:00:00');
            d.setDate(d.getDate() + 1);
            return d.toISOString().slice(0, 10);
          })();
          deadline = new Date(`${nextDay}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else {
          deadline = new Date(`${date}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        }
        
        if (deadline && new Date() > deadline) {
          return { error: 'La ventana de corrección cerró. Solicita al coordinador que haga la corrección.', status: 403 };
        }
      }
    }

    let originalTeacherId = user.id;
    let prevTardyIds  = new Set();
    let prevAbsentIds = new Set();

    {
      const { data: prevA } = await sb.from('raice_attendance')
        .select('student_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).eq('status', 'A');
      (prevA || []).forEach(r => prevAbsentIds.add(r.student_id));
    }

    if (['superadmin', 'admin'].includes(user.role)) {
      const { data: origRow } = await sb.from('raice_attendance')
        .select('teacher_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).limit(1);
      if (origRow && origRow[0]?.teacher_id) originalTeacherId = origRow[0].teacher_id;

      const { data: prevT } = await sb.from('raice_attendance')
        .select('student_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).eq('status', 'T');
      (prevT || []).forEach(r => prevTardyIds.add(r.student_id));
    }

    await AttendanceRepository.deleteRecords(course_id, date, hour);

    const isAllS = records.every(r => r.status === 'S');
    const noteValue = (isAllS && activity_note) ? String(activity_note).slice(0, 200) : null;
    const rows = records.map(r => ({
      student_id: r.student_id,
      course_id,
      teacher_id: originalTeacherId,
      date,
      class_hour: hour,
      status: ['P','A','PE','T','S'].includes(r.status) ? r.status : 'P',
      activity_note: noteValue
    }));

    const insertRes = await AttendanceRepository.insertRecords(rows);
    if (insertRes.error) return { error: 'Database error', status: 500 };

    try {
      const { data: desertoresReg } = await sb.from('raice_students')
        .select('id').eq('course_id', course_id).eq('status', 'desertor');
      let desertorIds = (desertoresReg || []).map(s => s.id);

      const { data: subMembers } = await sb.from('raice_subgroup_members')
        .select('student_id').eq('subgroup_course_id', course_id);
      if (subMembers?.length) {
        const memberIds = subMembers.map(m => m.student_id);
        const { data: desertoresMiembros } = await sb.from('raice_students')
          .select('id').in('id', memberIds).eq('status', 'desertor');
        desertorIds = [...new Set([...desertorIds, ...(desertoresMiembros || []).map(s => s.id)])];
      }

      const submittedIds = new Set(records.map(r => r.student_id));
      desertorIds = desertorIds.filter(id => !submittedIds.has(id));

      if (desertorIds.length > 0) {
        const desertorRows = desertorIds.map(sid => ({
          student_id: sid, course_id, teacher_id: null, date, class_hour: hour, status: 'A'
        }));
        await AttendanceRepository.insertRecords(desertorRows);
      }
    } catch (_) { /* no crítico */ }

    if (['superadmin', 'admin'].includes(user.role)) {
      const { data: courseInfo } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();
      const g = courseInfo?.grade || '?', n = courseInfo?.number || '?';

      const removedTardy = records
        .filter(r => prevTardyIds.has(r.student_id) && r.status !== 'T')
        .map(r => r.student_id);
      if (removedTardy.length > 0) {
        await sb.from('raice_notifications')
          .delete()
          .eq('type', 'tardanza')
          .in('link_id', removedTardy)
          .like('body', `%${date}%`);
      }

      const studentIds = records.map(r => r.student_id);
      if (reevaluateEvasionsFn) await reevaluateEvasionsFn(course_id, date, studentIds);

      if (logActivityFn) {
        await logActivityFn('attendance_correction',
          `Corrección de asistencia — ${g}°${n} — ${hour}ª hora — ${date} — por @${user.username}`);
      }
      return { success: true, saved: rows.length, corrected_by: user.username, tardes: 0, evasiones: 0, evadidos: [], status: 200 };
    }

    const tardes = records.filter(r => r.status === 'T');
    if (tardes.length > 0) {
      const { data: courseData } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();
      const grade  = courseData?.grade  || '?';
      const number = courseData?.number || '?';
      const { data: studentData } = await sb.from('raice_students')
        .select('id, first_name, last_name').in('id', tardes.map(t => t.student_id));
      const studentMap = {};
      (studentData || []).forEach(s => studentMap[s.id] = `${s.first_name} ${s.last_name}`);
      const { data: admins } = await sb.from('raice_users')
        .select('id').eq('role', 'admin').eq('active', true);
      const ordinals = ['1ª','2ª','3ª','4ª','5ª','6ª','7ª','8ª'];
      const hourLabel = ordinals[hour-1] || hour + 'ª';
      
      for (const t of tardes) {
        const studentName = studentMap[t.student_id] || 'Estudiante';
        for (const admin of (admins || [])) {
          if (sendNotificationFn) {
            await sendNotificationFn(admin.id, 'tardanza', `⏰ Tardanza — ${studentName}`, `${grade}°${number} · ${hourLabel} hora · ${date}`, t.student_id);
          }
        }
      }
      if (logActivityFn) {
        await logActivityFn('tardanza', `${tardes.length} tardanza(s) en ${grade}°${number} — ${hourLabel} hora — ${date}`);
      }
    }

    let evasiones = 0;
    let evadidosInfo = [];
    if (hour >= 2) {
      const absentesAhora = records.filter(r => r.status === 'A').map(r => r.student_id);
      if (absentesAhora.length > 0) {
        const { data: prevAtt } = await sb.from('raice_attendance')
          .select('student_id, status, class_hour, teacher_id')
          .eq('course_id', course_id)
          .eq('date', date)
          .lt('class_hour', hour)
          .in('student_id', absentesAhora);

        const presentesAntes = new Set();
        const prevTeacherMap = {};
        (prevAtt || []).forEach(r => {
          if (r.status === 'P') {
            presentesAntes.add(r.student_id);
            if (!prevTeacherMap[r.student_id] || r.class_hour > (prevTeacherMap[r.student_id].hour || 0)) {
              prevTeacherMap[r.student_id] = { teacherId: r.teacher_id, hour: r.class_hour };
            }
          }
        });

        const evadidos = absentesAhora.filter(sid => presentesAntes.has(sid));

        if (evadidos.length > 0) {
          const { data: courseData2 } = await sb.from('raice_courses')
            .select('grade, number, director_id').eq('id', course_id).single();
          const grade2  = courseData2?.grade  || '?';
          const number2 = courseData2?.number || '?';

          const { data: studentData2 } = await sb.from('raice_students')
            .select('id, first_name, last_name').in('id', evadidos);
          const studentMap2 = {};
          (studentData2 || []).forEach(s => studentMap2[s.id] = `${s.first_name} ${s.last_name}`);

          const { data: admins2 } = await sb.from('raice_users')
            .select('id').eq('role', 'admin').eq('active', true);

          const ordinals2 = ['1ª','2ª','3ª','4ª','5ª','6ª','7ª','8ª'];
          const hourLabel2 = ordinals2[hour-1] || hour + 'ª';
          const prevHourLabel = ordinals2[hour-2] || (hour-1) + 'ª';

          const prevTIds = [...new Set(evadidos.map(sid => prevTeacherMap[sid]?.teacherId).filter(Boolean))];
          const prevTNameMap = {};
          if (prevTIds.length) {
            const { data: ptRows } = await sb.from('raice_users')
              .select('id, first_name, last_name').in('id', prevTIds);
            (ptRows||[]).forEach(t => prevTNameMap[t.id] = `${t.first_name} ${t.last_name}`);
          }

          for (const sid of evadidos) {
            const studentName = studentMap2[sid] || 'Estudiante';
            const titulo = `🚨 Posible evasión — ${studentName}`;
            const prevTId   = prevTeacherMap[sid]?.teacherId;
            const prevTName = prevTId ? (prevTNameMap[prevTId] || '') : '';
            const cuerpo  = `${grade2}°${number2} · Estaba en ${prevHourLabel} hora${prevTName ? ' con '+prevTName : ''}, ausente en ${hourLabel2} hora · ${date}`;
            evadidosInfo.push({ student_id: sid, student_name: studentName, body: cuerpo });

            if (sendNotificationFn) {
              for (const admin of (admins2 || [])) {
                await sendNotificationFn(admin.id, 'evasion', titulo, cuerpo, sid);
              }
              if (courseData2?.director_id && courseData2.director_id !== user.id) {
                await sendNotificationFn(courseData2.director_id, 'evasion', titulo, cuerpo, sid);
              }
              const prevTeacherId = prevTeacherMap[sid]?.teacherId;
              if (prevTeacherId && prevTeacherId !== user.id) {
                await sendNotificationFn(prevTeacherId, 'evasion', titulo, cuerpo, sid);
              }
            }
            evasiones++;
          }
          if (logActivityFn) {
            await logActivityFn('evasion', `${evadidos.length} posible(s) evasión en ${grade2}°${number2} — ${hourLabel2} hora — ${date}`);
          }
        }
      }
    }

    const studentIds = records.map(r => r.student_id);
    if (reevaluateEvasionsFn) await reevaluateEvasionsFn(course_id, date, studentIds);

    if (logActivityFn) {
      await logActivityFn('attendance', `Asistencia ${hour}ª hora — Curso ${course_id} — ${date}`);
    }
    
    return { success: true, saved: rows.length, tardes: tardes.length, evasiones, evadidos: evadidosInfo, status: 200 };
  }
}
