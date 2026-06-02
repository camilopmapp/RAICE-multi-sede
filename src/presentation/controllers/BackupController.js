import { getSupabase } from '../../data/supabaseClient.js';
import { requireRole, logActivity, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, _dbErr, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';
import { todayCO, dayOfWeekCO } from '../../shared/utils/date.js';
import { checkRateLimit, checkRateLimitPortal, verifyToken } from '../../shared/utils/authHelpers.js';
import { UserRepository } from '../../data/repositories/UserRepository.js';
import { CasesRepository } from '../../data/repositories/CasesRepository.js';
import { ConfigRepository } from '../../data/repositories/ConfigRepository.js';
import { CoursesRepository } from '../../data/repositories/CoursesRepository.js';
import { SchedulesRepository } from '../../data/repositories/SchedulesRepository.js';
import { AttendanceRepository } from '../../data/repositories/AttendanceRepository.js';
import { StudentsRepository } from '../../data/repositories/StudentsRepository.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const _JWT_SECRET = process.env.JWT_SECRET;

export class BackupController {
  static async handleBackupExport(...args) {
    return await handleBackupExport(...args);
  }

  static async handleBackupCsv(...args) {
    return await handleBackupCsv(...args);
  }

  static async handleBackupEmail(...args) {
    return await handleBackupEmail(...args);
  }

  static async handleBackupImport(...args) {
    return await handleBackupImport(...args);
  }

  static async handlePurge(...args) {
    return await handlePurge(...args);
  }

}

async function handleBackupExport(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb = getSupabase();

  try {
    // Cada consulta retorna [] si falla — un error en una tabla no rompe todo el backup
    const sq = (promise) => promise.then(r => r.data || []).catch(() => []);

    // ── Tablas con paginación (pueden tener muchos registros) ──────────────────
    // Asistencia: se pagina de 10.000 en 10.000 hasta traer todo
    async function fetchAllAttendance() {
      let all = [];
      let from = 0;
      const PAGE = 1000; // Supabase default max_rows es 1000 — paginar en bloques de 1000
      while (true) {
        const { data, error } = await sb
          .from('raice_attendance')
          .select('*')
          .order('date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    }

    // ── Tablas estáticas (una sola consulta cada una) ──────────────────────────
    const [
      students,
      cases,
      followups,
      citations,
      commitments,
      observations,
      acudientes,
      teachers,
      courses,
      schedules,
      bellSchedule,
      teacherCourses,
      teacherAbsences,
      absenceReplacements,
      suspensions,
      classroomRemovals,
      excusas,
      faltas,
      periods,
      config,
      calendar,
      notifications,
      studentGradeHistory,
      logs,
      tipo1Escalones,
    ] = await Promise.all([
      sq(sb.from('raice_students').select('*').order('grade').order('last_name')),
      sq(sb.from('raice_cases').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_followups').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_citations').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_commitments').select('*').order('due_date', { ascending: false })),
      sq(sb.from('raice_observations').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_acudientes').select('*')),
      sq(sb.from('raice_users').select('id,username,first_name,last_name,email,role,active,last_login').neq('role','superadmin')),
      sq(sb.from('raice_courses').select('*').order('grade').order('number')),
      sq(sb.from('raice_schedules').select('*')),
      sq(sb.from('raice_bell_schedule').select('*').order('class_hour')),
      sq(sb.from('raice_teacher_courses').select('*')),
      sq(sb.from('raice_teacher_absences').select('*').order('date', { ascending: false })),
      sq(sb.from('raice_absence_replacements').select('*')),
      sq(sb.from('raice_suspensions').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_classroom_removals').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_excusas').select('*').order('date', { ascending: false })),
      sq(sb.from('raice_faltas_catalogo').select('*')),
      sq(sb.from('raice_periods').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_config').select('*')),
      sq(sb.from('raice_calendar').select('*').order('date', { ascending: false })),
      sq(sb.from('raice_notifications').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_student_grade_history').select('*').order('changed_at', { ascending: false })),
      sq(sb.from('raice_logs').select('*').order('created_at', { ascending: false })),
      sq(sb.from('raice_tipo1_escalones').select('*').order('created_at', { ascending: false })),
    ]);

    // Asistencia paginada (sin límite)
    const attendance = await fetchAllAttendance();

    const backup = {
      exported_at: new Date().toISOString(),
      version: '3.0',
      totals: {
        students:              students.length,
        attendance:            attendance.length,
        cases:                 cases.length,
        followups:             followups.length,
        citations:             citations.length,
        commitments:           commitments.length,
        observations:          observations.length,
        acudientes:            acudientes.length,
        teachers:              teachers.length,
        role_teachers:         teachers.filter(u => u.role === 'teacher').length,
        role_coordinators:     teachers.filter(u => u.role === 'admin').length,
        role_rectores:         teachers.filter(u => u.role === 'rector').length,
        courses:               courses.length,
        schedules:             schedules.length,
        bell_schedule:         bellSchedule.length,
        teacher_courses:       teacherCourses.length,
        teacher_absences:      teacherAbsences.length,
        absence_replacements:  absenceReplacements.length,
        suspensions:           suspensions.length,
        classroom_removals:    classroomRemovals.length,
        excusas:               excusas.length,
        faltas_catalogo:       faltas.length,
        periods:               periods.length,
        calendar:              calendar.length,
        notifications:         notifications.length,
        student_grade_history: studentGradeHistory.length,
        logs:                  logs.length,
        tipo1_escalones:       tipo1Escalones.length,
      },
      tables: {
        // Datos operativos principales
        students,
        attendance,
        cases,
        followups,
        citations,
        commitments,
        observations,
        acudientes,
        // Usuarios y estructura académica
        teachers,
        courses,
        schedules,
        bell_schedule:          bellSchedule,
        teacher_courses:        teacherCourses,
        teacher_absences:       teacherAbsences,
        absence_replacements:   absenceReplacements,
        // Convivencia extendida
        suspensions,
        classroom_removals:     classroomRemovals,
        excusas,
        // Configuración del colegio
        faltas_catalogo:        faltas,
        periods,
        config,
        calendar,
        // Sistema
        notifications,
        student_grade_history:  studentGradeHistory,
        logs,
        tipo1_escalones:        tipo1Escalones,
      }
    };

    try {
      await sb.from('raice_logs').insert({
        user_id: user.id,
        event_type: 'backup_export',
        detail: `Backup completo v3.0 exportado por @${user.username} — ${attendance.length} registros de asistencia, ${students.length} estudiantes, ${cases.length} casos`
      });
    } catch(_) {}

    const json = JSON.stringify(backup);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="raice-backup-${new Date().toISOString().split('T')[0]}.json"`);
    res.status(200);
    res.end(json);
  } catch (backupErr) {
    console.error('Backup export error:', backupErr?.message, backupErr?.stack);
    return res.status(500).json({ error: 'Error al generar el backup. Inténtalo de nuevo.' });
  }
}

async function handleBackupCsv(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'students';
  const sheets = {};

  if (type === 'students' || type === 'full') {
    const { data } = await sb.from('raice_students').select('*').order('grade').order('last_name');
    sheets['Estudiantes'] = (data || []).map(s => ({
      'Grado': s.grade, 'Curso': s.course,
      'Apellidos': s.last_name, 'Nombres': s.first_name,
      'Tipo Doc': s.doc_type, 'Número Doc': s.doc_number,
      'Fecha Nac': s.birth_date, 'Estado': s.status, 'Notas': s.notes || ''
    }));
  }

  if (type === 'attendance' || type === 'full') {
    const { data } = await sb.from('raice_attendance')
      .select('date, status, class_hour, student_id')
      .order('date', { ascending: false }).limit(20000);
    sheets['Asistencia'] = (data || []).map(r => ({
      'Fecha': r.date, 'Hora': r.class_hour,
      'Student ID': r.student_id || '',
      'Estado': r.status === 'P' ? 'Presente' : r.status === 'A' ? 'Ausente' : r.status === 'T' ? 'Tarde' : 'Con permiso'
    }));
  }

  if (type === 'cases' || type === 'full') {
    const { data } = await sb.from('raice_cases').select('*').order('created_at', { ascending: false });
    sheets['Casos'] = (data || []).map(c => ({
      'Fecha': c.created_at?.split('T')[0], 'Tipo': c.type,
      'Estudiante': c.student_name, 'Grado': c.grade, 'Curso': c.course,
      'Descripción': c.description, 'Estado': c.status,
      'Docente': c.teacher_name || ''
    }));
  }

  if (type === 'teachers' || type === 'full') {
    const { data } = await sb.from('raice_users')
      .select('first_name, last_name, username, email, role, active, last_login')
      .in('role', ['teacher','admin']).order('first_name');
    sheets['Docentes'] = (data || []).map(u => ({
      'Apellidos': u.last_name, 'Nombres': u.first_name,
      'Usuario': u.username, 'Correo': u.email || '',
      'Rol': u.role === 'teacher' ? 'Docente' : 'Coordinador',
      'Activo': u.active ? 'Sí' : 'No',
      'Último acceso': u.last_login ? u.last_login.split('T')[0] : ''
    }));
  }

  if (!Object.keys(sheets).length) return res.status(400).json({ error: 'Tipo no válido' });

  try { await sb.from('raice_logs').insert({ user_id: user.id, event_type: 'backup_excel', detail: `Excel exportado (${type}) por @${user.username}` }); } catch(_) {}

  return res.status(200).json({ sheets });
}

async function handleBackupEmail(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { email: overrideEmail, test } = req.body || {};

  const { data: config } = await sb.from('raice_config').select('*').eq('id', 1).maybeSingle();
  const destEmail  = overrideEmail || config?.backup_email;
  const resendKey  = process.env.RESEND_API_KEY || config?.resend_api_key;
  const schoolName = config?.school_name || 'RAICE';

  if (!destEmail) return res.status(400).json({ error: 'No hay correo destino configurado' });
  if (!resendKey) return res.status(400).json({ error: 'No hay clave de Resend configurada. Agrégala en Configuración o como variable de entorno RESEND_API_KEY.' });

  const sq2 = (p) => p.then(r => r.data || []).catch(() => []);
  const [students, attendance, cases, courses] = await Promise.all([
    sq2(sb.from('raice_students').select('*').order('grade').order('last_name')),
    sq2(sb.from('raice_attendance').select('*').order('date', { ascending: false }).limit(30000)),
    sq2(sb.from('raice_cases').select('*').order('created_at', { ascending: false })),
    sq2(sb.from('raice_courses').select('*').order('grade')),
  ]);

  const backupJson   = JSON.stringify({ exported_at: new Date().toISOString(), school: schoolName,
    tables: { students, attendance, cases, courses }
  }, null, 2);
  const backupBase64 = Buffer.from(backupJson).toString('base64');
  const date         = todayCO();
  const stats        = { estudiantes: students.length, asistencia: attendance.length, casos: cases.length };

  const emailBody = `
    <h2>💾 Backup RAICE — ${schoolName}</h2>
    <p>Generado: <strong>${new Date().toLocaleString('es-CO')}</strong></p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>👥 Estudiantes</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.estudiantes}</td></tr>
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>📋 Registros asistencia</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.asistencia}</td></tr>
      <tr><td style="padding:6px 12px;background:#f0fdf4;border:1px solid #bbf7d0;"><strong>⚠️ Casos RAICE</strong></td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${stats.casos}</td></tr>
    </table>
    <p style="margin-top:16px;color:#64748b;font-size:13px;">Adjunto: <code>raice_backup_${date}.json</code>${test ? ' — <strong style="color:#f59e0b;">ENVÍO DE PRUEBA</strong>' : ''}</p>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'backup@raice.app',
      to: [destEmail],
      subject: `${test ? '[PRUEBA] ' : ''}Backup RAICE — ${schoolName} — ${date}`,
      html: emailBody,
      attachments: [{ filename: `raice_backup_${date}.json`, content: backupBase64 }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return res.status(500).json({ error: err.message || 'Error al enviar con Resend' });
  }

  try { await sb.from('raice_logs').insert({ user_id: user.id, event_type: 'backup_email', detail: `Backup enviado a ${destEmail}${test ? ' (prueba)' : ''}` }); } catch(_) {}

  return res.status(200).json({ success: true, sent_to: destEmail });
}

async function handleBackupImport(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();

  const sb = getSupabase();
  const { backup, confirm_phrase, confirm_username, confirm_password, step,
          tableName, rows, deleteFirst } = req.body || {};

  const errors  = [];
  const results = {};

  async function upsertBatch(tableName, rows, batchSize = 300) {
    if (!rows || !rows.length) return 0;
    let total = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await sb.from(tableName).upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (error) { errors.push(`${tableName}: ${error.message}`); }
      else total += batch.length;
    }
    return total;
  }

  // ── Paso 2: tablas grandes en paralelo — JWT verificado, sin re-confirmación
  if (step === 2) {
    const [usersRes, studentsRes, coursesRes] = await Promise.all([
      sb.from('raice_users').select('id'),
      sb.from('raice_students').select('id'),
      sb.from('raice_courses').select('id'),
    ]);

    const validUserIds    = new Set((usersRes.data    || []).map(u => u.id));
    const validStudentIds = new Set((studentsRes.data || []).map(s => s.id));
    const validCourseIds  = new Set((coursesRes.data   || []).map(c => c.id));

    const attRows = (backup?.tables?.attendance || []).filter(r => {
      return r.student_id && validStudentIds.has(r.student_id) &&
             r.course_id && validCourseIds.has(r.course_id);
    }).map(r => ({
      ...r,
      teacher_id:   r.teacher_id && validUserIds.has(r.teacher_id) ? r.teacher_id : null,
      corrected_by: r.corrected_by && validUserIds.has(r.corrected_by) ? r.corrected_by : null,
    }));

    const obsRows = (backup?.tables?.observations || []).filter(r => {
      return r.student_id && validStudentIds.has(r.student_id);
    }).map(r => ({
      ...r,
      teacher_id: r.teacher_id && validUserIds.has(r.teacher_id) ? r.teacher_id : null,
      course_id:  r.course_id && validCourseIds.has(r.course_id) ? r.course_id : null,
    }));

    const gradeRows = (backup?.tables?.student_grade_history || []).filter(r => {
      return r.student_id && validStudentIds.has(r.student_id);
    }).map(r => ({
      ...r,
      from_course_id: r.from_course_id && validCourseIds.has(r.from_course_id) ? r.from_course_id : null,
      to_course_id:   r.to_course_id && validCourseIds.has(r.to_course_id) ? r.to_course_id : null,
      changed_by:     r.changed_by && validUserIds.has(r.changed_by) ? r.changed_by : null,
    }));

    const [attR, obsR, gradeHistR] = await Promise.all([
      upsertBatch('raice_attendance',            attRows,   1000),
      upsertBatch('raice_observations',          obsRows,   300),
      upsertBatch('raice_student_grade_history', gradeRows, 300),
    ]);
    results.attendance = attR; results.observations = obsR; results.student_grade_history = gradeHistR;
    return res.status(200).json({
      success: errors.length === 0, results, errors,
      message: errors.length > 0 ? `Datos grandes con ${errors.length} advertencia(s)` : 'Restaurado correctamente'
    });
  }

  // ── Chunk: upsert de un lote pequeño (frontend envía de a 100) ───────────
  if (step === 'chunk') {
    const ALLOWED = new Set(['raice_students', 'raice_acudientes']);
    if (!ALLOWED.has(tableName)) return res.status(400).json({ error: 'Tabla no permitida' });
    if (deleteFirst) {
      const { error: dErr } = await sb.from(tableName)
        .delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (dErr) errors.push(`delete_${tableName}: ${dErr.message}`);
    }
    let safeRows = rows || [];
    // Para estudiantes: si falla por FK de course_id, reintentar con course_id=null
    if (tableName === 'raice_students') {
      const { data: existingCourses } = await sb.from('raice_courses').select('id');
      const validIds = new Set((existingCourses || []).map(c => c.id));
      safeRows = safeRows.map(s => ({
        ...s,
        course_id: s.course_id && validIds.has(s.course_id) ? s.course_id : null,
      }));
    }
    const count = await upsertBatch(tableName, safeRows, 100);
    return res.status(200).json({ success: errors.length === 0, imported: count, errors });
  }

  // ── Cases: tablas que dependen de estudiantes (pequeñas, una sola llamada) ─
  if (step === 'cases') {
    const tc = backup?.tables || {};
    const validStats2 = new Set(['open', 'tracking', 'closed']);

    // Query currently existing IDs in the database to prevent FK violations
    const { data: dbUsers } = await sb.from('raice_users').select('id');
    const { data: dbStudents } = await sb.from('raice_students').select('id');
    const { data: dbCourses } = await sb.from('raice_courses').select('id');
    const { data: dbFaltas } = await sb.from('raice_faltas_catalogo').select('id');

    const userIdsSet = new Set((dbUsers || []).map(u => u.id));
    const studentIdsSet = new Set((dbStudents || []).map(s => s.id));
    const courseIdsSet = new Set((dbCourses || []).map(c => c.id));
    const faltaIdsSet = new Set((dbFaltas || []).map(f => f.id));

    // Sanitize cases
    const casesFixed2 = (tc.cases || []).map(c => ({
      ...c,
      student_id: c.student_id && studentIdsSet.has(c.student_id) ? c.student_id : null,
      course_id: c.course_id && courseIdsSet.has(c.course_id) ? c.course_id : null,
      teacher_id: c.teacher_id && userIdsSet.has(c.teacher_id) ? c.teacher_id : null,
      closed_by: c.closed_by && userIdsSet.has(c.closed_by) ? c.closed_by : null,
      falta_id: c.falta_id && faltaIdsSet.has(c.falta_id) ? c.falta_id : null,
      status: validStats2.has(c.status) ? c.status : 'tracking',
    }));

    // Keep track of valid case IDs (since we are inserting them, all restored cases are valid)
    const caseIdsSet = new Set(casesFixed2.map(c => c.id));

    // Sanitize followups (discard orphans without a valid case)
    const followupsFixed = (tc.followups || [])
      .filter(f => f.case_id && caseIdsSet.has(f.case_id))
      .map(f => ({
        ...f,
        coordinator_id: f.coordinator_id && userIdsSet.has(f.coordinator_id) ? f.coordinator_id : null,
      }));

    // Sanitize citations
    const citationsFixed = (tc.citations || []).map(ci => ({
      ...ci,
      student_id: ci.student_id && studentIdsSet.has(ci.student_id) ? ci.student_id : null,
      case_id: ci.case_id && caseIdsSet.has(ci.case_id) ? ci.case_id : null,
      coordinator_id: ci.coordinator_id && userIdsSet.has(ci.coordinator_id) ? ci.coordinator_id : null,
    }));

    // Sanitize commitments
    const commitmentsFixed = (tc.commitments || []).map(cm => ({
      ...cm,
      case_id: cm.case_id && caseIdsSet.has(cm.case_id) ? cm.case_id : null,
      student_id: cm.student_id && studentIdsSet.has(cm.student_id) ? cm.student_id : null,
    }));

    // Sanitize suspensions (student_id & coordinator_id cannot be null/invalid due to DB constraints)
    const suspensionsFixed = (tc.suspensions || [])
      .filter(s => s.student_id && studentIdsSet.has(s.student_id))
      .map(s => ({
        ...s,
        coordinator_id: s.coordinator_id && userIdsSet.has(s.coordinator_id) ? s.coordinator_id : user.id,
        case_id: s.case_id && caseIdsSet.has(s.case_id) ? s.case_id : null,
      }));

    // Sanitize classroom removals (student_id, teacher_id, course_id cannot be null/invalid)
    const classroomFixed = (tc.classroom_removals || [])
      .filter(r => r.student_id && studentIdsSet.has(r.student_id) && r.course_id && courseIdsSet.has(r.course_id))
      .map(r => ({
        ...r,
        teacher_id: r.teacher_id && userIdsSet.has(r.teacher_id) ? r.teacher_id : user.id,
        reviewed_by: r.reviewed_by && userIdsSet.has(r.reviewed_by) ? r.reviewed_by : null,
      }));

    // Sanitize tipo1_escalones
    const escalonesFixed = (tc.tipo1_escalones || [])
      .filter(e => e.case_id && caseIdsSet.has(e.case_id));

    // Sanitize excusas
    const excusasFixed = (tc.excusas || []).map(e => ({
      ...e,
      student_id: e.student_id && studentIdsSet.has(e.student_id) ? e.student_id : null,
    }));

    const [casesR, followupsR, citationsR, commitmentsR, suspensionsR, classroomR] = await Promise.all([
      upsertBatch('raice_cases',              casesFixed2),
      upsertBatch('raice_followups',          followupsFixed),
      upsertBatch('raice_citations',          citationsFixed),
      upsertBatch('raice_commitments',        commitmentsFixed),
      upsertBatch('raice_suspensions',        suspensionsFixed),
      upsertBatch('raice_classroom_removals', classroomFixed),
    ]);
    results.cases = casesR; results.followups = followupsR; results.citations = citationsR;
    results.commitments = commitmentsR; results.suspensions = suspensionsR;
    results.classroom_removals = classroomR;
    results.tipo1_escalones = await upsertBatch('raice_tipo1_escalones', escalonesFixed);
    try { results.excusas = await upsertBatch('raice_excusas', excusasFixed); } catch (_) {}
    return res.status(200).json({ success: errors.length === 0, results, errors });
  }

  // ── Paso 1: todo excepto asistencia — requiere confirmación ───────────────
  // Rate limit solo en el paso inicial (operación destructiva)
  if (!checkRateLimit(req, res)) return;
  if ((confirm_phrase || '').trim().toUpperCase() !== 'RESTAURAR') {
    return res.status(400).json({ error: 'Frase de confirmación incorrecta. Escribe exactamente: RESTAURAR' });
  }
  if (!confirm_username || !confirm_password) {
    return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  }
  // Verificar credenciales del superadmin contra la BD
  const { data: adminRow } = await sb.from('raice_users')
    .select('id, password_hash, role')
    .eq('username', confirm_username.trim())
    .eq('role', 'superadmin')
    .maybeSingle();
  if (!adminRow) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const passwordOk = await bcrypt.compare(confirm_password, adminRow.password_hash);
  if (!passwordOk) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!backup || !backup.tables) {
    return res.status(400).json({ error: 'Archivo de backup inválido o sin datos' });
  }

  const t = backup.tables;

  // ── 1. Sin dependencias externas ─────────────────────────────────────────
  if (t.config?.length) {
    // Solo importar columnas conocidas para evitar fallos por columnas extra en el backup
    const c = t.config[0];
    const safeConfig = {
      id: c.id ?? 1,
      school_name: c.school_name, location: c.location, dane_code: c.dane_code,
      year: c.year, logo_url: c.logo_url, num_periods: c.num_periods,
      periods_config: c.periods_config, classes_per_day: c.classes_per_day,
      session_timeout: c.session_timeout, correction_window: c.correction_window,
      correction_window_minutes: c.correction_window_minutes,
      correction_window_hour: c.correction_window_hour,
      backup_email: c.backup_email, resend_api_key: c.resend_api_key,
    };
    const { error } = await sb.from('raice_config').upsert(safeConfig, { onConflict: 'id' });
    if (error) errors.push('config: ' + error.message);
    else results.config = 1;
  }
  results.faltas_catalogo = await upsertBatch('raice_faltas_catalogo', t.faltas_catalogo);
  results.bell_schedule   = await upsertBatch('raice_bell_schedule',   t.bell_schedule);
  // Períodos: borrar los del mismo año antes de importar para evitar conflicto UNIQUE(year,period_num)
  if (t.periods?.length) {
    const years = [...new Set(t.periods.map(p => p.year).filter(Boolean))];
    for (const y of years) await sb.from('raice_periods').delete().eq('year', y);
  }
  results.periods = await upsertBatch('raice_periods', t.periods);
  results.calendar        = await upsertBatch('raice_calendar',        t.calendar);

  // ── 2. Cursos (sin director aún) — 2 queries en vez de N ─────────────────
  if (t.courses?.length) {
    const backupCourseIds = new Set(t.courses.map(c => c.id));
    const { data: existingCourses } = await sb.from('raice_courses').select('id');
    const toDelete = (existingCourses || []).filter(c => !backupCourseIds.has(c.id)).map(c => c.id);
    if (toDelete.length) await sb.from('raice_courses').delete().in('id', toDelete);
  }
  const coursesNullDir = (t.courses || []).map(c => ({ ...c, director_id: null }));
  results.courses = await upsertBatch('raice_courses', coursesNullDir);

  // ── 3. Usuarios (docentes) — batch upsert preservando password_hash ───────
  if (t.teachers?.length) {
    const ids = t.teachers.map(u => u.id);
    const { data: existing } = await sb.from('raice_users')
      .select('id, password_hash').in('id', ids);
    const existingMap = Object.fromEntries((existing || []).map(u => [u.id, u.password_hash]));

    const tempHash = await bcrypt.hash('Cambiar123!', 10);
    const usersToUpsert = t.teachers.map(u => ({
      id: u.id, username: u.username, first_name: u.first_name,
      last_name: u.last_name, email: u.email || null,
      role: u.role, active: u.active ?? true,
      // Mantener contraseña existente; para usuarios nuevos usar hash temporal
      password_hash: existingMap[u.id] ?? tempHash,
    }));

    // Upsert en lotes — para conflicto de email: reintentar sin email uno a uno
    for (let i = 0; i < usersToUpsert.length; i += 50) {
      const batch = usersToUpsert.slice(i, i + 50);
      const { error: uErr } = await sb.from('raice_users')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (uErr) {
        if (uErr.code === '23505' && uErr.message?.toLowerCase().includes('email')) {
          // Conflicto de email: reintentar el lote sin emails
          const { error: retryErr } = await sb.from('raice_users')
            .upsert(batch.map(u => ({ ...u, email: null })), { onConflict: 'id' });
          if (retryErr) errors.push(`users_upsert: ${retryErr.message}`);
          else errors.push('Algunos emails duplicados — importados sin email, actualizar manualmente');
        } else {
          errors.push(`users_upsert: ${uErr.message}`);
        }
      }
    }
    results.users = t.teachers.length;
  }

  // ── 4. Actualizar director_id — 1 upsert en vez de N updates ─────────────
  const coursesWithDir = (t.courses || []).filter(c => c.director_id);
  if (coursesWithDir.length) {
    await sb.from('raice_courses').upsert(
      coursesWithDir.map(c => ({ id: c.id, grade: c.grade, number: c.number, director_id: c.director_id })),
      { onConflict: 'id' }
    );
  }

  // ── 5. Tablas sin dependencia de estudiantes (paralelo) ──────────────────
  const [teacherCoursesR, schedulesR, teacherAbsR, absReplR] = await Promise.all([
    upsertBatch('raice_teacher_courses',      t.teacher_courses),
    upsertBatch('raice_schedules',            t.schedules),
    upsertBatch('raice_teacher_absences',     t.teacher_absences),
    upsertBatch('raice_absence_replacements', t.absence_replacements),
  ]);
  results.teacher_courses = teacherCoursesR; results.schedules = schedulesR;
  results.teacher_absences = teacherAbsR; results.absence_replacements = absReplR;

  await logActivity(sb, user.id, 'backup_import',
    `Backup v${backup.version||'?'} paso-1 restaurado. Errores: ${errors.length}`);

  const role_stats = {
    role_teachers:     (t.teachers || []).filter(u => u.role === 'teacher').length,
    role_coordinators: (t.teachers || []).filter(u => u.role === 'admin').length,
    role_rectores:     (t.teachers || []).filter(u => u.role === 'rector').length,
  };

  return res.status(200).json({
    success: errors.length === 0,
    results,
    role_stats,
    errors,
    message: errors.length > 0
      ? `Restaurado con ${errors.length} advertencia(s)`
      : 'Backup restaurado correctamente'
  });
}

async function handlePurge(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'DELETE') return res.status(405).end();
  const sb = getSupabase();
  const { target, date_from, date_to, before, status, mode } = req.body || {};

  if (target === 'attendance') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });
    const { error, count } = await sb.from('raice_attendance')
      .delete({ count: 'exact' }).gte('date', date_from).lte('date', date_to);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', `Asistencia eliminada: ${date_from} a ${date_to}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'attendance_nr') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });
    // Delete records where status is null or explicitly 'NR' (if used)
    const { error, count } = await sb.from('raice_attendance')
      .delete({ count: 'exact' })
      .gte('date', date_from)
      .lte('date', date_to)
      .or('status.is.null,status.eq.NR');
    
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', `Asistencia NR eliminada: ${date_from} a ${date_to}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'cases') {
    // Get IDs before deletion to clean up orphan notifications
    let qIds = sb.from('raice_cases').select('id');
    if (status === 'all') {
      qIds = qIds.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      qIds = qIds.eq('status', status || 'closed');
    }
    const { data: toDelete } = await qIds;
    const caseIdsToDelete = (toDelete||[]).map(c => c.id);

    // Delete the cases
    let q = sb.from('raice_cases').delete({ count: 'exact' });
    if (status === 'all') {
      q = q.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      q = q.eq('status', status || 'closed');
    }
    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    // Mark notifications for deleted cases as read (removes from Alertas)
    if (caseIdsToDelete.length) {
      await sb.from('raice_notifications')
        .update({ read: true }).in('link_id', caseIdsToDelete);
    }

    await logActivity(sb, user.id, 'purge', `Casos eliminados: ${status || 'closed'}`);
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'citations') {
    const { error, count } = await sb.from('raice_citations').delete({ count: 'exact' }).neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) return res.status(500).json({ error: _dbErr(error) });
    await logActivity(sb, user.id, 'purge', 'Citaciones eliminadas');
    return res.status(200).json({ success: true, deleted: count });
  }

  if (target === 'logs') {
    if (!before) return res.status(400).json({ error: 'Fecha límite requerida' });
    const { error, count } = await sb.from('raice_logs')
      .delete({ count: 'exact' }).lt('created_at', before);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── RETIROS DE CLASE ──────────────────────────────────────
  if (target === 'removals') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });

    // Check how many are linked to open RAICE cases (via student_id + date overlap)
    const { data: removalRows } = await sb.from('raice_classroom_removals')
      .select('student_id').gte('date', date_from).lte('date', date_to);

    let linkedToOpenCases = 0;
    if (removalRows?.length) {
      const studentIds = [...new Set(removalRows.map(r => r.student_id).filter(Boolean))];
      if (studentIds.length) {
        const { count } = await sb.from('raice_cases')
          .select('id', { count: 'exact', head: true })
          .in('student_id', studentIds).neq('status', 'closed');
        linkedToOpenCases = count || 0;
      }
    }

    const { error, count } = await sb.from('raice_classroom_removals')
      .delete({ count: 'exact' }).gte('date', date_from).lte('date', date_to);
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Retiros eliminados: ${date_from} a ${date_to} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count, linked_to_open_cases: linkedToOpenCases });
  }

  // ── EVASIONES ─────────────────────────────────────────────
  if (target === 'evasions') {
    if (!date_from || !date_to) return res.status(400).json({ error: 'Rango de fechas requerido' });

    // Evasions are stored as notifications with type='evasion'
    // mode: 'read' = only read/processed, 'all' = everything in range
    let q = sb.from('raice_notifications')
      .delete({ count: 'exact' })
      .eq('type', 'evasion')
      .gte('created_at', date_from + 'T00:00:00')
      .lte('created_at', date_to + 'T23:59:59');

    if (mode === 'read') {
      q = q.eq('read', true);
    }
    // mode === 'all' → no extra filter

    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Evasiones eliminadas: ${date_from} a ${date_to} — modo: ${mode || 'all'} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── NOTIFICACIONES / ALERTAS ──────────────────────────────
  if (target === 'notifications') {
    const notif_type = req.body?.notif_type || 'all';
    const before     = req.body?.before;

    let q = sb.from('raice_notifications').delete({ count: 'exact' });

    if (notif_type === 'read') {
      q = q.eq('read', true);
    } else if (notif_type !== 'all') {
      q = q.eq('type', notif_type);
    }

    if (before) {
      q = q.lte('created_at', before + 'T23:59:59');
    }

    const { error, count } = await q;
    if (error) return res.status(500).json({ error: _dbErr(error) });

    await logActivity(sb, user.id, 'purge',
      `Notificaciones eliminadas — tipo: ${notif_type}${before ? ' antes de ' + before : ''} — ${count} registros`);
    return res.status(200).json({ success: true, deleted: count });
  }

  // ── OMISIONES DE ASISTENCIA (registro masivo NR) ──────────
  if (target === 'omissions') {
    const date = req.body?.date;
    if (!date) return res.status(400).json({ error: 'Fecha requerida' });

    const dow = dayOfWeekCO(date);

    // Todas las sesiones programadas para ese día de la semana
    const { data: scheds, error: schedErr } = await sb.from('raice_schedules')
      .select('class_hour, raice_teacher_courses(teacher_id, course_id)')
      .eq('day_of_week', dow);
    if (schedErr) return res.status(500).json({ error: _dbErr(schedErr) });
    if (!scheds || scheds.length === 0) {
      return res.status(200).json({ success: true, sessions: 0, registered: 0 });
    }

    // Sesiones que ya tienen asistencia registrada para esa fecha
    const { data: existing } = await sb.from('raice_attendance')
      .select('course_id, class_hour, status').eq('date', date);
    const takenSet = new Set(
      (existing || [])
        .filter(a => a.status !== 'PE' && a.status !== 'NR')
        .map(a => `${a.course_id}_${a.class_hour}`)
    );

    // Sesiones faltantes deduplicadas por course_id + class_hour
    const sessionMap = new Map();
    for (const s of scheds) {
      const tc = s.raice_teacher_courses;
      if (!tc?.course_id) continue;
      const key = `${tc.course_id}_${s.class_hour}`;
      if (!takenSet.has(key) && !sessionMap.has(key)) {
        sessionMap.set(key, { course_id: tc.course_id, teacher_id: tc.teacher_id, class_hour: s.class_hour });
      }
    }

    if (sessionMap.size === 0) {
      return res.status(200).json({ success: true, sessions: 0, registered: 0 });
    }

    const now = new Date().toISOString();
    let totalRegistered = 0;

    for (const session of sessionMap.values()) {
      const { data: students } = await sb.from('raice_students')
        .select('id').eq('course_id', session.course_id).eq('status', 'active');
      if (!students?.length) continue;

      const rows = students.map(s => ({
        student_id:        s.id,
        course_id:         session.course_id,
        teacher_id:        session.teacher_id || user.id,
        date,
        class_hour:        session.class_hour,
        status:            'NR',
        corrected_by:      user.id,
        corrected_at:      now,
        correction_reason: 'omision_docente_bulk',
      }));

      let { error: insErr } = await sb.from('raice_attendance').insert(rows);
      if (insErr && (insErr.message.includes('corrected_by') || insErr.message.includes('correction_reason'))) {
        const rowsBasic = rows.map(({ corrected_by: _a, corrected_at: _b, correction_reason: _c, ...rest }) => rest);
        const r2 = await sb.from('raice_attendance').insert(rowsBasic);
        insErr = r2.error;
      }
      if (!insErr) totalRegistered += students.length;
    }

    await logActivity(sb, user.id, 'purge',
      `Omisiones en bloque — ${date} — ${sessionMap.size} sesiones — ${totalRegistered} registros NR — por @${user.username}`);
    return res.status(200).json({ success: true, sessions: sessionMap.size, registered: totalRegistered });
  }

  return res.status(400).json({ error: 'Target no válido' });
}

