import { getSupabase } from '../../data/supabaseClient.js';
import { logActivity } from '../../shared/utils/apiHelpers.js';

function todayCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split('T')[0];
}

export class AttendanceController {
  static async function handleAttendance(req, res, user, url) {
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { course_id, date, class_hour, records, activity_note } = req.body || {};
    if (!course_id || !date || !records?.length) return res.status(400).json({ error: 'Datos incompletos' });

    const hour = parseInt(class_hour) || 1;

    // Validate that this teacher is assigned to this course
    if (user.role === 'teacher') {
      // A teacher may teach multiple subjects in the same course → multiple rows
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('id').eq('teacher_id', user.id).eq('course_id', course_id);
      if (!tcRows || !tcRows.length) {
        return res.status(403).json({ error: 'No tienes acceso a este curso' });
      }
      // Validate hour against schedule.
      // If raice_schedules table does not exist yet (migration pending),
      // skip validation so attendance can still be saved.
      try {
        const tcIds     = tcRows.map(r => r.id);
        const dayOfWeek = dayOfWeekCO(date);

        // Fetch schedules for ALL teacher_course rows of this teacher+course
        const { data: schedRows, error: schedErr } = await sb.from('raice_schedules')
          .select('class_hour').in('teacher_course_id', tcIds).eq('day_of_week', dayOfWeek);

        if (!schedErr) {
          const scheduledHours = (schedRows || []).map(s => s.class_hour);
          if (scheduledHours.length === 0) {
            // No schedule for today — check if ANY schedule exists for this teacher+course at all
            const { data: anyRows } = await sb.from('raice_schedules')
              .select('id').in('teacher_course_id', tcIds).limit(1);
            if (anyRows && anyRows.length > 0) {
              // Schedules exist for other days but not today → block
              return res.status(403).json({ error: 'Este docente no tiene clase hoy con este curso según el horario configurado.' });
            }
            // No schedule at all for this teacher+course → allow (school hasn't set up schedules yet)
          } else if (!scheduledHours.includes(hour)) {
            return res.status(403).json({ error: `No tienes clase en la ${hour}ª hora con este curso` });
          }
        }
      } catch (_) { /* tabla no disponible, permitir guardado */ }

      // Fix 2: bloquear guardado si es fecha pasada (fechas distintas al día actual en Colombia)
      const today = todayCO();
      if (date !== today) {
        return res.status(423).json({ error: 'Solo puedes registrar asistencia del día actual.' });
      }

      // Fix 3: verificar ownership y ventana de corrección si ya existen registros
      const { data: existingRec } = await sb.from('raice_attendance')
        .select('id, teacher_id, created_at')
        .eq('course_id', course_id).eq('date', date).eq('class_hour', hour)
        .limit(1).maybeSingle();
      if (existingRec) {
        if (existingRec.teacher_id !== user.id) {
          return res.status(403).json({ error: 'Esta asistencia fue registrada por otro docente. Solo el coordinador puede corregirla.' });
        }
        // Verificar ventana de corrección configurada en raice_config
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
            // Build deadline as Colombia local time then convert to UTC (+5h)
            deadline = new Date(`${date}T${String(parseInt(ch)).padStart(2,'0')}:${String(parseInt(cm)).padStart(2,'0')}:00.000Z`);
            deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
          } else {
            // Fallback: N minutos desde el guardado
            deadline = new Date(new Date(existingRec.created_at).getTime() + windowMinutes * 60000);
          }
        } else if (windowType === 'same_day_hour') {
          // windowHour is a Colombia local time string like "17:00"
          const wh = String(windowHour || '23:59').padStart(5, '0');
          const [wHH, wMM] = wh.split(':').map(Number);
          // Interpret as Colombia time (UTC-5): add 5 hours to get UTC
          deadline = new Date(`${date}T${String(wHH).padStart(2,'0')}:${String(wMM).padStart(2,'0')}:00.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else if (windowType === 'next_day_end') {
          // Day after list date at 23:59:59 Colombia time → UTC
          const nextDay = (() => {
            const d = new Date(date + 'T12:00:00');
            d.setDate(d.getDate() + 1);
            return d.toISOString().slice(0, 10);
          })();
          deadline = new Date(`${nextDay}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        } else { // same_day_end (default)
          // 23:59:59 Colombia time = next day 04:59:59 UTC
          deadline = new Date(`${date}T23:59:59.000Z`);
          deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
        }
        if (deadline && new Date() > deadline) {
          return res.status(403).json({ error: 'La ventana de corrección cerró. Solicita al coordinador que haga la corrección.' });
        }
      }
    }

    // Try to delete with class_hour; if column doesn't exist, delete without it
    // For coordinator corrections: preserve the original teacher_id so trazabilidad is maintained
    let originalTeacherId = user.id;
    let prevTardyIds = new Set();
    if (['superadmin', 'admin'].includes(user.role)) {
      // Look up who originally recorded this hour so we preserve their teacher_id
      const { data: origRow } = await sb.from('raice_attendance')
        .select('teacher_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).limit(1);
      if (origRow && origRow[0]?.teacher_id) originalTeacherId = origRow[0].teacher_id;

      // Capture students with T status before overwriting — needed to clean up notifications
      const { data: prevT } = await sb.from('raice_attendance')
        .select('student_id').eq('course_id', course_id).eq('date', date).eq('class_hour', hour).eq('status', 'T');
      (prevT || []).forEach(r => prevTardyIds.add(r.student_id));
    }

    const delResult = await sb.from('raice_attendance').delete()
      .eq('course_id', course_id).eq('date', date).eq('class_hour', hour);
    if (delResult.error && delResult.error.message.includes('class_hour')) {
      // Column doesn't exist yet — delete by date+course only
      await sb.from('raice_attendance').delete().eq('course_id', course_id).eq('date', date);
    }

    // Try to insert with class_hour; if column doesn't exist, insert without it
    const isAllS = records.every(r => r.status === 'S');
    const noteValue = (isAllS && activity_note) ? String(activity_note).slice(0, 200) : null;
    const rows = records.map(r => ({
      student_id: r.student_id,
      course_id,
      teacher_id: originalTeacherId, // preserve original teacher; coordinator id goes to audit log
      date,
      class_hour: hour,
      status: ['P','A','PE','T','S'].includes(r.status) ? r.status : 'P',
      activity_note: noteValue
    }));

    let { error } = await sb.from('raice_attendance').insert(rows);
    if (error && error.message.includes('activity_note')) {
      // Column doesn't exist yet — retry without it
      const rowsNoNote = rows.map(r => { const { activity_note: _, ...rest } = r; return rest; });
      const res1 = await sb.from('raice_attendance').insert(rowsNoNote);
      error = res1.error;
    }
    if (error && (error.message.includes('class_hour') || error.message.includes('status'))) {
      // Fallback: insert without class_hour, map T→PE for old schema
      const fallbackRows = records.map(r => ({
        student_id: r.student_id,
        course_id,
        teacher_id: originalTeacherId,
        date,
        status: r.status === 'T' ? 'PE' : (['P','A','PE'].includes(r.status) ? r.status : 'P')
      }));
      const res2 = await sb.from('raice_attendance').insert(fallbackRows);
      error = res2.error;
    }
    if (error) return res.status(500).json({ error: _dbErr(error, '') });

    // Coordinator correction — audit log only, skip tardanza/evasion notifications
    if (['superadmin', 'admin'].includes(user.role)) {
      const { data: courseInfo } = await sb.from('raice_courses')
        .select('grade, number').eq('id', course_id).single();
      const g = courseInfo?.grade || '?', n = courseInfo?.number || '?';

      // Remove tardanza notifications for students corrected away from T
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

      await logActivity(sb, user.id, 'attendance_correction',
        `Corrección de asistencia — ${g}°${n} — ${hour}ª hora — ${date} — por @${user.username}`);
      return res.status(200).json({ success: true, saved: rows.length, corrected_by: user.username });
    }

    // Process tardanzas — notify coordinators
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
          await sendNotification(sb, admin.id, user.id, 'tardanza',
            `⏰ Tardanza — ${studentName}`,
            `${grade}°${number} · ${hourLabel} hora · ${date}`,
            t.student_id
          );
        }
      }
      await logActivity(sb, user.id, 'tardanza',
        `${tardes.length} tardanza(s) en ${grade}°${number} — ${hourLabel} hora — ${date}`);
    }

    // ---- DETECCIÓN DE EVASIÓN ----
    // Si esta es hora >= 2, buscar estudiantes que en una hora anterior
    // estuvieron PRESENTES (P) pero ahora están AUSENTES (A)
    let evasiones = 0;
    if (hour >= 2) {
      const absentesAhora = records.filter(r => r.status === 'A').map(r => r.student_id);
      if (absentesAhora.length > 0) {
        // Obtener registros de horas anteriores del mismo día/curso
        // Incluir teacher_id para saber quién registró la hora anterior
        const { data: prevAtt } = await sb.from('raice_attendance')
          .select('student_id, status, class_hour, teacher_id')
          .eq('course_id', course_id)
          .eq('date', date)
          .lt('class_hour', hour)
          .in('student_id', absentesAhora);

        // Estudiantes que SÍ estuvieron presentes en alguna hora anterior
        // y mapa de estudiante -> docente que registró esa hora
        const presentesAntes = new Set();
        const prevTeacherMap = {}; // student_id -> teacher_id de la hora anterior con P
        (prevAtt || []).forEach(r => {
          if (r.status === 'P') {
            presentesAntes.add(r.student_id);
            // Guardar el teacher_id de la hora más reciente con P
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

          // Look up names of previous-hour teachers in one batch
          const prevTIds = [...new Set(evadidos.map(sid => prevTeacherMap[sid]?.teacherId).filter(Boolean))];
          const prevTNameMap = {};
          if (prevTIds.length) {
            const { data: ptRows } = await sb.from('raice_users')
              .select('id, first_name, last_name').in('id', prevTIds);
            (ptRows||[]).forEach(t => prevTNameMap[t.id] = `${t.first_name} ${t.last_name}`);
          }

          // Notificar a cada estudiante evadido
          for (const sid of evadidos) {
            const studentName = studentMap2[sid] || 'Estudiante';
            const titulo = `🚨 Posible evasión — ${studentName}`;
            const prevTId   = prevTeacherMap[sid]?.teacherId;
            const prevTName = prevTId ? (prevTNameMap[prevTId] || '') : '';
            const cuerpo  = `${grade2}°${number2} · Estaba en ${prevHourLabel} hora${prevTName ? ' con '+prevTName : ''}, ausente en ${hourLabel2} hora · ${date}`;

            // 1. Notificar a todos los coordinadores
            for (const admin of (admins2 || [])) {
              await sendNotification(sb, admin.id, user.id, 'evasion', titulo, cuerpo, sid);
            }
            // 2. Notificar al director de grado si existe y es distinto del docente actual
            if (courseData2?.director_id && courseData2.director_id !== user.id) {
              await sendNotification(sb, courseData2.director_id, user.id, 'evasion', titulo, cuerpo, sid);
            }
            // 3. Notificar al docente que registró la hora anterior (si es distinto al actual)
            const prevTeacherId = prevTeacherMap[sid]?.teacherId;
            if (prevTeacherId && prevTeacherId !== user.id) {
              await sendNotification(sb, prevTeacherId, user.id, 'evasion', titulo, cuerpo, sid);
            }
            evasiones++;
          }
          await logActivity(sb, user.id, 'evasion',
            `${evadidos.length} posible(s) evasión en ${grade2}°${number2} — ${hourLabel2} hora — ${date}`);
        }
      }
    }

    await logActivity(sb, user.id, 'attendance',
      `Asistencia ${hour}ª hora — Curso ${course_id} — ${date}`);
    return res.status(200).json({ success: true, saved: rows.length, tardes: tardes.length, evasiones });
  }

  if (req.method === 'GET') {
    requireRole(user, 'superadmin', 'admin');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const date_from = url.searchParams.get('date_from');
    const date_to   = url.searchParams.get('date_to');

    // ── RANGE MODE (semana / mes / período / año) ────────────────────
    if (date_from && date_to) {
      const { data: attData } = await sb.from('raice_attendance')
        .select('status, course_id, class_hour, student_id, teacher_id, date')
        .gte('date', date_from).lte('date', date_to);

      // Deduplicate: per student + course + date → keep last hour's status
      const scdMap = {};
      (attData||[]).forEach(r => {
        const key = `${r.student_id}_${r.course_id}_${r.date}`;
        if (!scdMap[key] || r.class_hour > scdMap[key].class_hour) scdMap[key] = r;
      });
      const deduped = Object.values(scdMap);

      const present = deduped.filter(r => ['P','PE','S'].includes(r.status)).length;
      const absent  = deduped.filter(r => r.status === 'A').length;
      const permit  = deduped.filter(r => r.status === 'PE').length;
      const late    = deduped.filter(r => r.status === 'T').length;

      // Course + teacher lookups
      const cIds = [...new Set(deduped.map(r => r.course_id).filter(Boolean))];
      const tIds = [...new Set(deduped.map(r => r.teacher_id).filter(Boolean))];
      const courseMap2 = {}, teacherMap2 = {};
      if (cIds.length) {
        const { data: cr } = await sb.from('raice_courses').select('id,grade,number').in('id', cIds);
        (cr||[]).forEach(c => courseMap2[c.id] = c);
      }
      if (tIds.length) {
        const { data: tr } = await sb.from('raice_users').select('id,first_name,last_name').in('id', tIds);
        (tr||[]).forEach(t => teacherMap2[t.id] = `${t.first_name} ${t.last_name}`);
      }

      const byCourse = {};
      deduped.forEach(r => {
        if (!r.course_id) return;
        if (!byCourse[r.course_id]) {
          const c = courseMap2[r.course_id] || {};
          byCourse[r.course_id] = {
            course_id: r.course_id,
            grade: c.grade ?? '?', course: c.number ?? '?',
            teacher: teacherMap2[r.teacher_id] || '—',
            present:0, absent:0, late:0, permit:0, total:0
          };
        }
        byCourse[r.course_id].total++;
        const s = r.status;
        if (s==='P'||s==='S') byCourse[r.course_id].present++;
        else if (s==='PE')    { byCourse[r.course_id].present++; byCourse[r.course_id].permit++; }
        else if (s==='A')      byCourse[r.course_id].absent++;
        else if (s==='T')      byCourse[r.course_id].late++;
      });
      const courses = Object.values(byCourse)
        .map(c => ({ ...c, pct: c.total>0 ? Math.round((c.present/c.total)*100) : 0 }))
        .sort((a,b) => a.grade - b.grade || a.course - b.course);

      return res.status(200).json({ present, absent, permit, late, courses, mode: 'range' });
    }

    // ── DAY MODE (comportamiento original intacto) ───────────────────
    const date = url.searchParams.get('date') || todayCO();
    const full = url.searchParams.get('full') === 'true';

    // ── FULL LIST MODE (lista completa estudiante × hora) ────────────
    if (full) {
      const { data: rawData } = await sb.from('raice_attendance')
        .select('student_id, class_hour, status, course_id')
        .eq('date', date);

      if (!rawData?.length) return res.status(200).json({ hours: [], students: [] });

      const stuIds = [...new Set(rawData.map(r => r.student_id).filter(Boolean))];
      const cIds   = [...new Set(rawData.map(r => r.course_id).filter(Boolean))];

      const [stuRes, crsRes] = await Promise.all([
        stuIds.length ? sb.from('raice_students').select('id,first_name,last_name').in('id', stuIds) : Promise.resolve({ data: [] }),
        cIds.length   ? sb.from('raice_courses').select('id,grade,number').in('id', cIds)           : Promise.resolve({ data: [] }),
      ]);

      const stuMap = {};
      (stuRes.data||[]).forEach(s => stuMap[s.id] = `${s.last_name}, ${s.first_name}`);
      const cMap = {};
      (crsRes.data||[]).forEach(c => cMap[c.id] = c);

      const hours = [...new Set(rawData.map(r => r.class_hour).filter(h => h != null))].sort((a,b) => a - b);

      const byStudent = {};
      rawData.forEach(r => {
        if (!r.student_id) return;
        if (!byStudent[r.student_id]) {
          const c = cMap[r.course_id] || {};
          byStudent[r.student_id] = {
            student_id: r.student_id,
            name: stuMap[r.student_id] || '—',
            grade: c.grade ?? '?',
            course: c.number ?? '?',
            course_id: r.course_id,
            by_hour: {}
          };
        }
        byStudent[r.student_id].by_hour[r.class_hour] = r.status;
      });

      const students = Object.values(byStudent)
        .sort((a,b) => (a.grade - b.grade) || String(a.course).localeCompare(String(b.course)) || a.name.localeCompare(b.name));

      return res.status(200).json({ hours, students });
    }

    // Get attendance without FK joins to avoid name issues
    const { data: attData } = await sb.from('raice_attendance')
      .select('status, course_id, class_hour, student_id, teacher_id').eq('date', date);

    // Deduplicate: if a student has multiple hours, use the most recent status per student per course
    const studentCourseMap = {};
    (attData||[]).forEach(r => {
      const key = r.student_id + '_' + r.course_id;
      if (!studentCourseMap[key] || r.class_hour > studentCourseMap[key].class_hour) {
        studentCourseMap[key] = r;
      }
    });
    const deduped = Object.values(studentCourseMap);

    const present = deduped.filter(r => r.status === 'P' || r.status === 'PE').length;
    const absent  = deduped.filter(r => r.status === 'A').length;
    const permit  = deduped.filter(r => r.status === 'PE').length;
    const late    = deduped.filter(r => r.status === 'T').length;

    // Get course details
    const courseIds = [...new Set((attData||[]).map(r => r.course_id).filter(Boolean))];
    const courseMap = {};
    if (courseIds.length) {
      const { data: courseRows } = await sb.from('raice_courses')
        .select('id, grade, number').in('id', courseIds);
      (courseRows||[]).forEach(c => courseMap[c.id] = c);
    }

    // Get teacher names per course
    const teacherIds = [...new Set((attData||[]).map(r => r.teacher_id).filter(Boolean))];
    const teacherMap = {};
    if (teacherIds.length) {
      const { data: teacherRows } = await sb.from('raice_users')
        .select('id, first_name, last_name').in('id', teacherIds);
      (teacherRows||[]).forEach(t => teacherMap[t.id] = `${t.first_name} ${t.last_name}`);
    }

    // Build per-course hour→teacher from raw data (before deduplication)
    const courseHourTeacher = {};
    (attData||[]).forEach(r => {
      if (!r.course_id || !r.teacher_id || r.class_hour == null) return;
      if (!courseHourTeacher[r.course_id]) courseHourTeacher[r.course_id] = {};
      if (!courseHourTeacher[r.course_id][r.class_hour])
        courseHourTeacher[r.course_id][r.class_hour] = teacherMap[r.teacher_id] || '—';
    });

    const byCoursemap = {};
    deduped.forEach(r => {
      const key = r.course_id;
      if (!key) return; // skip orphan records with no course_id
      const c   = courseMap[key] || {};
      if (!byCoursemap[key]) byCoursemap[key] = {
        course_id: key,              // always present — guarantees Editar button renders
        grade:   c.grade  ?? '?',
        course:  c.number ?? key,   // fallback to ID if number not configured
        teacher: teacherMap[r.teacher_id] || '—',
        present: 0, absent: 0, permit: 0, late: 0, total: 0
      };
      byCoursemap[key].total++;
      if (r.status === 'P')       byCoursemap[key].present++;
      else if (r.status === 'A')  byCoursemap[key].absent++;
      else if (r.status === 'T')  byCoursemap[key].late++;
      else                        byCoursemap[key].permit++;
    });

    const courses = Object.values(byCoursemap).map(c => {
      const hourMap = courseHourTeacher[c.course_id] || {};
      const teachers_by_hour = Object.entries(hourMap)
        .sort((a,b) => Number(a[0]) - Number(b[0]))
        .map(([h, name]) => ({ hour: Number(h), name }));
      return { ...c, teachers_by_hour, pct: c.total > 0 ? Math.round((c.present / c.total) * 100) : 0 };
    }).sort((a,b) => a.grade - b.grade || a.course - b.course);

    return res.status(200).json({ present, absent, permit, late, courses });
  }

  return res.status(405).end();
}



  static async function getAttendanceToday(sb) {
  const today = todayCO();
  const { data } = await sb.from('raice_attendance').select('status').eq('date', today);
  if (!data || !data.length) return null;
  // Only show % if a teacher actively took list (at least one P, A or T — not just PE from excusas)
  const hasRealList = data.some(r => r.status === 'P' || r.status === 'A' || r.status === 'T');
  if (!hasRealList) return null;
  const present = data.filter(r => r.status === 'P' || r.status === 'PE').length;
  return Math.round((present / data.length) * 100);
}

  static async function getMissingAttendance(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || todayCO();
  const dayNum = dayOfWeekCO(date); // 1=Lun … 7=Dom

  // 1. Todos los horarios programados para ese día de la semana
  const { data: schedRows } = await sb
    .from('raice_schedules')
    .select('class_hour, teacher_course_id')
    .eq('day_of_week', dayNum);

  if (!schedRows?.length) return res.status(200).json({ missing: [], date });

  const tcIds = [...new Set(schedRows.map(s => s.teacher_course_id).filter(Boolean))];

  // 2. Información de cada asignación docente-curso
  const { data: tcRows } = await sb
    .from('raice_teacher_courses')
    .select('id, course_id, subject, teacher_id')
    .in('id', tcIds);

  const tcMap = {};
  (tcRows || []).forEach(tc => { tcMap[tc.id] = tc; });

  // 3. Detalle de cursos y docentes
  const courseIds  = [...new Set((tcRows||[]).map(r => r.course_id).filter(Boolean))];
  const teacherIds = [...new Set((tcRows||[]).map(r => r.teacher_id).filter(Boolean))];

  const [{ data: courseRows }, { data: teacherRows }] = await Promise.all([
    sb.from('raice_courses').select('id, grade, number').in('id', courseIds),
    sb.from('raice_users').select('id, first_name, last_name').in('id', teacherIds),
  ]);

  const courseMap  = {};
  const teacherMap = {};
  (courseRows  || []).forEach(c => { courseMap[c.id]  = c; });
  (teacherRows || []).forEach(t => { teacherMap[t.id] = `${t.first_name} ${t.last_name}`; });

  // 4. Registros de asistencia que SÍ existen para esa fecha
  const { data: attRows } = await sb
    .from('raice_attendance')
    .select('course_id, class_hour')
    .eq('date', date);

  // Set de claves "course_id::class_hour" que ya tienen registro
  const savedSet = new Set((attRows || []).map(r => `${r.course_id}::${r.class_hour}`));

  // 5. Cruzar: sesiones programadas sin registro
  const missing = [];
  schedRows.forEach(s => {
    const tc = tcMap[s.teacher_course_id];
    if (!tc) return;
    const key = `${tc.course_id}::${s.class_hour}`;
    if (savedSet.has(key)) return; // ya registrada
    const course  = courseMap[tc.course_id]  || {};
    missing.push({
      course_id:   tc.course_id,
      grade:       course.grade  ?? '?',
      course_num:  course.number ?? '?',
      subject:     tc.subject    || '—',
      teacher:     teacherMap[tc.teacher_id] || '—',
      class_hour:  s.class_hour,
      date,
    });
  });

  // Ordenar por grado, curso, hora
  missing.sort((a, b) =>
    a.grade - b.grade || a.course_num - b.course_num || a.class_hour - b.class_hour
  );

  return res.status(200).json({ missing, date, count: missing.length });
}

  static async function getAttendanceByCourse(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const date      = url.searchParams.get('date') || todayCO();
  const hour      = parseInt(url.searchParams.get('hour')) || 1;

  if (!course_id) return res.status(400).json({ error: 'course_id requerido' });

  // Verify teacher has access to this course
  // Use limit(1) instead of .single() because a teacher may teach multiple
  // subjects in the same course → multiple rows in raice_teacher_courses
  if (user.role === 'teacher') {
    const { data: accessRows } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!accessRows || !accessRows.length) {
      return res.status(403).json({ error: 'No tienes acceso a este curso' });
    }
  }

  // Determinar si es subgrupo para cargar estudiantes correctamente
  const { data: courseTypeRow } = await sb.from('raice_courses')
    .select('type').eq('id', course_id).maybeSingle();

  let students;
  if (courseTypeRow?.type === 'subgroup') {
    const { data: memberRows } = await sb.from('raice_subgroup_members')
      .select('raice_students(id, first_name, last_name)')
      .eq('subgroup_course_id', course_id);
    students = (memberRows || [])
      .map(m => m.raice_students)
      .filter(Boolean)
      .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));
  } else {
    const { data: studentsData } = await sb.from('raice_students')
      .select('id, first_name, last_name').eq('course_id', course_id).eq('status', 'active')
      .order('last_name');
    students = studentsData || [];
  }

  // Get existing attendance for this date and hour
  const { data: attendance } = await sb.from('raice_attendance')
    .select('student_id, status, activity_note').eq('course_id', course_id).eq('date', date).eq('class_hour', hour);

  const attMap = {};
  (attendance || []).forEach(a => attMap[a.student_id] = a.status);

  // Check active suspensions for students in this course
  const studentIds = (students || []).map(s => s.id);
  let suspMap = {};
  if (studentIds.length) {
    const today = todayCO();
    const { data: suspRows } = await sb.from('raice_suspensions')
      .select('student_id, start_date, end_date, reason')
      .in('student_id', studentIds)
      .lte('start_date', today).gte('end_date', today);
    (suspRows || []).forEach(s => { suspMap[s.student_id] = s; });
  }

  // Fetch excusas for PE students on this date
  const peStudentIds = (students || [])
    .filter(s => !suspMap[s.id] && attMap[s.id] === 'PE')
    .map(s => s.id);

  let excusaMap = {};
  let excusaQueryOk = true;
  if (peStudentIds.length) {
    const { data: excusas, error: excusaErr } = await sb.from('raice_excusas')
      .select('student_id, motivo, horas, registered_by, raice_users(first_name, last_name)')
      .in('student_id', peStudentIds)
      .eq('date', date);
    if (excusaErr) {
      excusaQueryOk = false;
    } else {
      (excusas || []).forEach(e => { excusaMap[e.student_id] = e; });
    }
  }

  const studentsWithAtt = (students || []).map(s => ({
    ...s,
    // Suspended students → 'A'. Otherwise use saved status (PE manual is valid).
    attendance_status: suspMap[s.id] ? 'A' : (attMap[s.id] || 'P'),
    suspension: suspMap[s.id] || null,
    // Excusa info for PE students (tooltip)
    excusa: excusaMap[s.id] || null
  }));

  const activityNote = (attendance || []).find(a => a.activity_note)?.activity_note || null;
  
  // A list is considered "saved" only if EVERY active student has a record for this hour
  const isSaved = students && students.length > 0 && (attendance || []).length >= students.length;

  return res.status(200).json({
    students: studentsWithAtt,
    saved: isSaved,
    hour,
    activity_note: activityNote
  });
}

  static async function getAttendanceRange(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher', 'rector');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const from      = url.searchParams.get('from');
  const to        = url.searchParams.get('to');
  const hour      = url.searchParams.get('hour'); // optional

  if (!course_id || !from || !to)
    return res.status(400).json({ error: 'course_id, from y to son requeridos' });

  // Verify teacher access
  if (user.role === 'teacher') {
    const { data: access } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!access?.length) return res.status(403).json({ error: 'No tienes acceso a este curso' });
  }

  // Students in course
  const { data: students } = await sb.from('raice_students')
    .select('id, first_name, last_name').eq('course_id', course_id).eq('status','active')
    .order('last_name');

  // Attendance records in range
  let q = sb.from('raice_attendance')
    .select('student_id, date, class_hour, status')
    .eq('course_id', course_id)
    .gte('date', from).lte('date', to)
    .order('date').order('class_hour');
  if (hour) q = q.eq('class_hour', parseInt(hour));
  const { data: records } = await q;

  // Unique sorted dates that have at least one record
  const datesSet = new Set((records||[]).map(r => r.date));
  const dates = [...datesSet].sort();

  return res.status(200).json({
    students: students || [],
    dates,
    records: records || []
  });
}

  static async function unlockAttendance(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (user.role !== 'teacher') return res.status(403).json({ error: 'Solo docentes pueden solicitar corrección' });

  const sb = getSupabase();
  const { course_id, date, class_hour, reason } = req.body || {};
  if (!course_id || !date || !class_hour || !reason?.trim())
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  // ── Correction window validation ─────────────────────────
  let config = null;
  try {
    const { data: cfgData } = await sb.from('raice_config').select(
      'correction_window, correction_window_minutes, correction_window_hour'
    ).eq('id', 1).maybeSingle();
    config = cfgData;
  } catch (_) { /* columns not yet migrated — skip validation */ }

  const window_type    = config?.correction_window         || 'same_day_end';
  const window_minutes = config?.correction_window_minutes || 55;
  const window_hour    = config?.correction_window_hour    || '23:59';

  // Current time in Colombia (UTC-5)
  const nowCO = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const todayDateCO = nowCO.toISOString().slice(0, 10);

  // Build the deadline based on config
  let deadline = null;
  let windowLabel = '';

  if (window_type === 'class_duration') {
    // Find when this class hour was first saved and add window_minutes
    const { data: firstRecord } = await sb.from('raice_attendance')
      .select('created_at').eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (firstRecord?.created_at) {
      deadline = new Date(new Date(firstRecord.created_at).getTime() + window_minutes * 60 * 1000);
      windowLabel = `${window_minutes} minutos desde que se tomó la lista`;
    } else {
      // No record found — allow (list might not be saved yet)
      deadline = null;
    }
  } else if (window_type === 'same_day_hour') {
    // Same day up to a specific hour (e.g. "15:30")
    const [hh, mm] = (window_hour || '17:00').split(':').map(Number);
    deadline = new Date(`${date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
    // Convert the stored hour to UTC (Colombia is UTC-5, so stored local time + 5h = UTC)
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = `hasta las ${window_hour} del día de la lista`;
  } else if (window_type === 'same_day_end') {
    // Same day until 23:59:59 Colombia time
    deadline = new Date(`${date}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000); // to UTC
    windowLabel = 'hasta las 11:59 PM del día de la lista';
  } else if (window_type === 'next_day_end') {
    // Day after the list until 23:59:59 Colombia time
    const nextDay = (() => {
      const d = new Date(date + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    deadline = new Date(`${nextDay}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = 'hasta las 11:59 PM del día siguiente';
  }

  const nowUTC = new Date();
  if (deadline && nowUTC > deadline) {
    return res.status(403).json({
      error: `La ventana de corrección ya cerró (${windowLabel}). Solicita al coordinador que haga la corrección.`,
      window_closed: true
    });
  }

  // ── Access check ──────────────────────────────────────────
  const { data: tcRows } = await sb.from('raice_teacher_courses')
    .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);

  if (!tcRows?.length)
    return res.status(403).json({ error: 'No tienes acceso a este curso' });

  // Audit trail
  try {
    await sb.from('raice_attendance').update({
      corrected_by: user.id,
      corrected_at: new Date().toISOString(),
      correction_reason: reason.trim()
    }).eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour);
  } catch (_) {}

  await logActivity(sb, user.id, 'attendance_unlock',
    `Desbloqueó lista ${date} hora ${class_hour} curso ${course_id} — Motivo: ${reason.trim()}`);

  return res.status(200).json({ ok: true });
}

  static async function cleanupOrphanedPE(req, res, user) {
  requireRole(user, 'admin', 'superadmin');
  const sb = getSupabase();

  // Fetch all PE attendance records
  const { data: peRows, error: peErr } = await sb
    .from('raice_attendance')
    .select('id, student_id, date, class_hour, course_id')
    .eq('status', 'PE');
  if (peErr) return res.status(500).json({ error: _dbErr(peErr) });
  if (!peRows || !peRows.length) return res.status(200).json({ orphaned: 0, deleted: 0 });

  // Fetch all excusas (only student_id + date needed)
  const { data: excusas, error: excErr } = await sb
    .from('raice_excusas')
    .select('student_id, date, horas');
  if (excErr) return res.status(500).json({ error: _dbErr(excErr) });

  // Build a Set of "student_id|date" keys that ARE covered by an excusa
  // For excusas with specific hours, build "student_id|date|class_hour" keys
  const coveredKeys  = new Set();   // student_id|date  (all-hours excusas)
  const coveredHrKeys = new Set();  // student_id|date|class_hour (specific-hour excusas)
  (excusas || []).forEach(e => {
    if (!e.horas || !e.horas.length) {
      coveredKeys.add(`${e.student_id}|${e.date}`);
    } else {
      e.horas.forEach(h => coveredHrKeys.add(`${e.student_id}|${e.date}|${h}`));
    }
  });

  // Identify orphaned PE rows
  const orphanedIds = peRows
    .filter(r => {
      const dayKey = `${r.student_id}|${r.date}`;
      const hrKey  = `${r.student_id}|${r.date}|${r.class_hour}`;
      return !coveredKeys.has(dayKey) && !coveredHrKeys.has(hrKey);
    })
    .map(r => r.id);

  if (req.method === 'GET') {
    // Preview only — return count without deleting
    return res.status(200).json({ orphaned: orphanedIds.length });
  }

  if (req.method === 'DELETE') {
    if (!orphanedIds.length) return res.status(200).json({ deleted: 0 });

    // Delete in batches of 100 to stay within Supabase limits
    let deleted = 0;
    for (let i = 0; i < orphanedIds.length; i += 100) {
      const batch = orphanedIds.slice(i, i + 100);
      const { error } = await sb.from('raice_attendance').delete().in('id', batch);
      if (error) return res.status(500).json({ error: _dbErr(error), deleted });
      deleted += batch.length;
    }

    await logActivity(sb, user.id, 'cleanup',
      `Limpieza PE huérfanos: ${deleted} registros eliminados`);
    return res.status(200).json({ deleted });
  }

  return res.status(405).end();
}


  static async function getAttendanceToday(sb) {
  const today = todayCO();
  const { data } = await sb.from('raice_attendance').select('status').eq('date', today);
  if (!data || !data.length) return null;
  // Only show % if a teacher actively took list (at least one P, A or T — not just PE from excusas)
  const hasRealList = data.some(r => r.status === 'P' || r.status === 'A' || r.status === 'T');
  if (!hasRealList) return null;
  const present = data.filter(r => r.status === 'P' || r.status === 'PE').length;
  return Math.round((present / data.length) * 100);
}

  static async function getMissingAttendance(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || todayCO();
  const dayNum = dayOfWeekCO(date); // 1=Lun … 7=Dom

  // 1. Todos los horarios programados para ese día de la semana
  const { data: schedRows } = await sb
    .from('raice_schedules')
    .select('class_hour, teacher_course_id')
    .eq('day_of_week', dayNum);

  if (!schedRows?.length) return res.status(200).json({ missing: [], date });

  const tcIds = [...new Set(schedRows.map(s => s.teacher_course_id).filter(Boolean))];

  // 2. Información de cada asignación docente-curso
  const { data: tcRows } = await sb
    .from('raice_teacher_courses')
    .select('id, course_id, subject, teacher_id')
    .in('id', tcIds);

  const tcMap = {};
  (tcRows || []).forEach(tc => { tcMap[tc.id] = tc; });

  // 3. Detalle de cursos y docentes
  const courseIds  = [...new Set((tcRows||[]).map(r => r.course_id).filter(Boolean))];
  const teacherIds = [...new Set((tcRows||[]).map(r => r.teacher_id).filter(Boolean))];

  const [{ data: courseRows }, { data: teacherRows }] = await Promise.all([
    sb.from('raice_courses').select('id, grade, number').in('id', courseIds),
    sb.from('raice_users').select('id, first_name, last_name').in('id', teacherIds),
  ]);

  const courseMap  = {};
  const teacherMap = {};
  (courseRows  || []).forEach(c => { courseMap[c.id]  = c; });
  (teacherRows || []).forEach(t => { teacherMap[t.id] = `${t.first_name} ${t.last_name}`; });

  // 4. Registros de asistencia que SÍ existen para esa fecha
  const { data: attRows } = await sb
    .from('raice_attendance')
    .select('course_id, class_hour')
    .eq('date', date);

  // Set de claves "course_id::class_hour" que ya tienen registro
  const savedSet = new Set((attRows || []).map(r => `${r.course_id}::${r.class_hour}`));

  // 5. Cruzar: sesiones programadas sin registro
  const missing = [];
  schedRows.forEach(s => {
    const tc = tcMap[s.teacher_course_id];
    if (!tc) return;
    const key = `${tc.course_id}::${s.class_hour}`;
    if (savedSet.has(key)) return; // ya registrada
    const course  = courseMap[tc.course_id]  || {};
    missing.push({
      course_id:   tc.course_id,
      grade:       course.grade  ?? '?',
      course_num:  course.number ?? '?',
      subject:     tc.subject    || '—',
      teacher:     teacherMap[tc.teacher_id] || '—',
      class_hour:  s.class_hour,
      date,
    });
  });

  // Ordenar por grado, curso, hora
  missing.sort((a, b) =>
    a.grade - b.grade || a.course_num - b.course_num || a.class_hour - b.class_hour
  );

  return res.status(200).json({ missing, date, count: missing.length });
}

  static async function getAttendanceByCourse(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher');
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const date      = url.searchParams.get('date') || todayCO();
  const hour      = parseInt(url.searchParams.get('hour')) || 1;

  if (!course_id) return res.status(400).json({ error: 'course_id requerido' });

  // Verify teacher has access to this course
  // Use limit(1) instead of .single() because a teacher may teach multiple
  // subjects in the same course → multiple rows in raice_teacher_courses
  if (user.role === 'teacher') {
    const { data: accessRows } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!accessRows || !accessRows.length) {
      return res.status(403).json({ error: 'No tienes acceso a este curso' });
    }
  }

  // Determinar si es subgrupo para cargar estudiantes correctamente
  const { data: courseTypeRow } = await sb.from('raice_courses')
    .select('type').eq('id', course_id).maybeSingle();

  let students;
  if (courseTypeRow?.type === 'subgroup') {
    const { data: memberRows } = await sb.from('raice_subgroup_members')
      .select('raice_students(id, first_name, last_name)')
      .eq('subgroup_course_id', course_id);
    students = (memberRows || [])
      .map(m => m.raice_students)
      .filter(Boolean)
      .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));
  } else {
    const { data: studentsData } = await sb.from('raice_students')
      .select('id, first_name, last_name').eq('course_id', course_id).eq('status', 'active')
      .order('last_name');
    students = studentsData || [];
  }

  // Get existing attendance for this date and hour
  const { data: attendance } = await sb.from('raice_attendance')
    .select('student_id, status, activity_note').eq('course_id', course_id).eq('date', date).eq('class_hour', hour);

  const attMap = {};
  (attendance || []).forEach(a => attMap[a.student_id] = a.status);

  // Check active suspensions for students in this course
  const studentIds = (students || []).map(s => s.id);
  let suspMap = {};
  if (studentIds.length) {
    const today = todayCO();
    const { data: suspRows } = await sb.from('raice_suspensions')
      .select('student_id, start_date, end_date, reason')
      .in('student_id', studentIds)
      .lte('start_date', today).gte('end_date', today);
    (suspRows || []).forEach(s => { suspMap[s.student_id] = s; });
  }

  // Fetch excusas for PE students on this date
  const peStudentIds = (students || [])
    .filter(s => !suspMap[s.id] && attMap[s.id] === 'PE')
    .map(s => s.id);

  let excusaMap = {};
  let excusaQueryOk = true;
  if (peStudentIds.length) {
    const { data: excusas, error: excusaErr } = await sb.from('raice_excusas')
      .select('student_id, motivo, horas, registered_by, raice_users(first_name, last_name)')
      .in('student_id', peStudentIds)
      .eq('date', date);
    if (excusaErr) {
      excusaQueryOk = false;
    } else {
      (excusas || []).forEach(e => { excusaMap[e.student_id] = e; });
    }
  }

  const studentsWithAtt = (students || []).map(s => ({
    ...s,
    // Suspended students → 'A'. Otherwise use saved status (PE manual is valid).
    attendance_status: suspMap[s.id] ? 'A' : (attMap[s.id] || 'P'),
    suspension: suspMap[s.id] || null,
    // Excusa info for PE students (tooltip)
    excusa: excusaMap[s.id] || null
  }));

  const activityNote = (attendance || []).find(a => a.activity_note)?.activity_note || null;
  
  // A list is considered "saved" only if EVERY active student has a record for this hour
  const isSaved = students && students.length > 0 && (attendance || []).length >= students.length;

  return res.status(200).json({
    students: studentsWithAtt,
    saved: isSaved,
    hour,
    activity_note: activityNote
  });
}

  static async function getAttendanceRange(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'teacher', 'rector');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const course_id = url.searchParams.get('course_id');
  const from      = url.searchParams.get('from');
  const to        = url.searchParams.get('to');
  const hour      = url.searchParams.get('hour'); // optional

  if (!course_id || !from || !to)
    return res.status(400).json({ error: 'course_id, from y to son requeridos' });

  // Verify teacher access
  if (user.role === 'teacher') {
    const { data: access } = await sb.from('raice_teacher_courses')
      .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);
    if (!access?.length) return res.status(403).json({ error: 'No tienes acceso a este curso' });
  }

  // Students in course
  const { data: students } = await sb.from('raice_students')
    .select('id, first_name, last_name').eq('course_id', course_id).eq('status','active')
    .order('last_name');

  // Attendance records in range
  let q = sb.from('raice_attendance')
    .select('student_id, date, class_hour, status')
    .eq('course_id', course_id)
    .gte('date', from).lte('date', to)
    .order('date').order('class_hour');
  if (hour) q = q.eq('class_hour', parseInt(hour));
  const { data: records } = await q;

  // Unique sorted dates that have at least one record
  const datesSet = new Set((records||[]).map(r => r.date));
  const dates = [...datesSet].sort();

  return res.status(200).json({
    students: students || [],
    dates,
    records: records || []
  });
}

  static async function unlockAttendance(req, res, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (user.role !== 'teacher') return res.status(403).json({ error: 'Solo docentes pueden solicitar corrección' });

  const sb = getSupabase();
  const { course_id, date, class_hour, reason } = req.body || {};
  if (!course_id || !date || !class_hour || !reason?.trim())
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  // ── Correction window validation ─────────────────────────
  let config = null;
  try {
    const { data: cfgData } = await sb.from('raice_config').select(
      'correction_window, correction_window_minutes, correction_window_hour'
    ).eq('id', 1).maybeSingle();
    config = cfgData;
  } catch (_) { /* columns not yet migrated — skip validation */ }

  const window_type    = config?.correction_window         || 'same_day_end';
  const window_minutes = config?.correction_window_minutes || 55;
  const window_hour    = config?.correction_window_hour    || '23:59';

  // Current time in Colombia (UTC-5)
  const nowCO = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const todayDateCO = nowCO.toISOString().slice(0, 10);

  // Build the deadline based on config
  let deadline = null;
  let windowLabel = '';

  if (window_type === 'class_duration') {
    // Find when this class hour was first saved and add window_minutes
    const { data: firstRecord } = await sb.from('raice_attendance')
      .select('created_at').eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (firstRecord?.created_at) {
      deadline = new Date(new Date(firstRecord.created_at).getTime() + window_minutes * 60 * 1000);
      windowLabel = `${window_minutes} minutos desde que se tomó la lista`;
    } else {
      // No record found — allow (list might not be saved yet)
      deadline = null;
    }
  } else if (window_type === 'same_day_hour') {
    // Same day up to a specific hour (e.g. "15:30")
    const [hh, mm] = (window_hour || '17:00').split(':').map(Number);
    deadline = new Date(`${date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
    // Convert the stored hour to UTC (Colombia is UTC-5, so stored local time + 5h = UTC)
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = `hasta las ${window_hour} del día de la lista`;
  } else if (window_type === 'same_day_end') {
    // Same day until 23:59:59 Colombia time
    deadline = new Date(`${date}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000); // to UTC
    windowLabel = 'hasta las 11:59 PM del día de la lista';
  } else if (window_type === 'next_day_end') {
    // Day after the list until 23:59:59 Colombia time
    const nextDay = (() => {
      const d = new Date(date + 'T12:00:00');
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    deadline = new Date(`${nextDay}T23:59:59.000Z`);
    deadline = new Date(deadline.getTime() + 5 * 60 * 60 * 1000);
    windowLabel = 'hasta las 11:59 PM del día siguiente';
  }

  const nowUTC = new Date();
  if (deadline && nowUTC > deadline) {
    return res.status(403).json({
      error: `La ventana de corrección ya cerró (${windowLabel}). Solicita al coordinador que haga la corrección.`,
      window_closed: true
    });
  }

  // ── Access check ──────────────────────────────────────────
  const { data: tcRows } = await sb.from('raice_teacher_courses')
    .select('id').eq('teacher_id', user.id).eq('course_id', course_id).limit(1);

  if (!tcRows?.length)
    return res.status(403).json({ error: 'No tienes acceso a este curso' });

  // Audit trail
  try {
    await sb.from('raice_attendance').update({
      corrected_by: user.id,
      corrected_at: new Date().toISOString(),
      correction_reason: reason.trim()
    }).eq('course_id', course_id).eq('date', date).eq('class_hour', class_hour);
  } catch (_) {}

  await logActivity(sb, user.id, 'attendance_unlock',
    `Desbloqueó lista ${date} hora ${class_hour} curso ${course_id} — Motivo: ${reason.trim()}`);

  return res.status(200).json({ ok: true });
}

  static async function cleanupOrphanedPE(req, res, user) {
  requireRole(user, 'admin', 'superadmin');
  const sb = getSupabase();

  // Fetch all PE attendance records
  const { data: peRows, error: peErr } = await sb
    .from('raice_attendance')
    .select('id, student_id, date, class_hour, course_id')
    .eq('status', 'PE');
  if (peErr) return res.status(500).json({ error: _dbErr(peErr) });
  if (!peRows || !peRows.length) return res.status(200).json({ orphaned: 0, deleted: 0 });

  // Fetch all excusas (only student_id + date needed)
  const { data: excusas, error: excErr } = await sb
    .from('raice_excusas')
    .select('student_id, date, horas');
  if (excErr) return res.status(500).json({ error: _dbErr(excErr) });

  // Build a Set of "student_id|date" keys that ARE covered by an excusa
  // For excusas with specific hours, build "student_id|date|class_hour" keys
  const coveredKeys  = new Set();   // student_id|date  (all-hours excusas)
  const coveredHrKeys = new Set();  // student_id|date|class_hour (specific-hour excusas)
  (excusas || []).forEach(e => {
    if (!e.horas || !e.horas.length) {
      coveredKeys.add(`${e.student_id}|${e.date}`);
    } else {
      e.horas.forEach(h => coveredHrKeys.add(`${e.student_id}|${e.date}|${h}`));
    }
  });

  // Identify orphaned PE rows
  const orphanedIds = peRows
    .filter(r => {
      const dayKey = `${r.student_id}|${r.date}`;
      const hrKey  = `${r.student_id}|${r.date}|${r.class_hour}`;
      return !coveredKeys.has(dayKey) && !coveredHrKeys.has(hrKey);
    })
    .map(r => r.id);

  if (req.method === 'GET') {
    // Preview only — return count without deleting
    return res.status(200).json({ orphaned: orphanedIds.length });
  }

  if (req.method === 'DELETE') {
    if (!orphanedIds.length) return res.status(200).json({ deleted: 0 });

    // Delete in batches of 100 to stay within Supabase limits
    let deleted = 0;
    for (let i = 0; i < orphanedIds.length; i += 100) {
      const batch = orphanedIds.slice(i, i + 100);
      const { error } = await sb.from('raice_attendance').delete().in('id', batch);
      if (error) return res.status(500).json({ error: _dbErr(error), deleted });
      deleted += batch.length;
    }

    await logActivity(sb, user.id, 'cleanup',
      `Limpieza PE huérfanos: ${deleted} registros eliminados`);
    return res.status(200).json({ deleted });
  }

  return res.status(405).end();
}

}
