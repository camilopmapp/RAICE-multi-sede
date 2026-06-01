import { getSupabase } from '../../data/supabaseClient.js';
import { logActivity, _dbErr, requireRole, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';

function todayCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split('T')[0];
}

export class ConfigController {
  static async function handleConfig(req, res, user) {
  // GET is public to all authenticated users (teachers need logo_url and classes_per_day)
  // POST is restricted to superadmin/admin
  if (req.method === 'POST') requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'POST') {
    const { school_name, location, dane_code, year, num_periods, periods_config, classes_per_day, logo_url,
            correction_window, correction_window_minutes, correction_window_hour } = req.body || {};
    const updates = {};
    if (school_name    !== undefined) updates.school_name    = school_name;
    if (location       !== undefined) updates.location       = location;
    if (dane_code      !== undefined) updates.dane_code      = dane_code;
    if (year           !== undefined) updates.year           = year;
    if (num_periods    !== undefined) updates.num_periods    = num_periods;
    if (periods_config !== undefined) updates.periods_config = periods_config;
    if (classes_per_day !== undefined) updates.classes_per_day = classes_per_day;
    if (logo_url !== undefined) updates.logo_url = logo_url || null;
    // Correction window settings
    if (correction_window         !== undefined) updates.correction_window         = correction_window;
    if (correction_window_minutes !== undefined) updates.correction_window_minutes = correction_window_minutes;
    if (correction_window_hour    !== undefined) {
      // Ensure the value is stored as TEXT in HH:MM format.
      // The column was mistakenly created as INTEGER in some deployments,
      // so we validate the format here to give a clear error instead of a 500.
      if (correction_window_hour !== null) {
        const hourStr = String(correction_window_hour).trim();
        if (!/^\d{2}:\d{2}$/.test(hourStr)) {
          return res.status(400).json({ error: 'Formato de hora inválido. Use HH:MM (ej: 17:00)' });
        }
        updates.correction_window_hour = hourStr;
      } else {
        updates.correction_window_hour = null;
      }
    }

    // Try update first, then insert if no row exists
    const { data: existing } = await sb.from('raice_config').select('id').eq('id', 1).maybeSingle();
    let error;
    if (existing) {
      ({ error } = await sb.from('raice_config').update(updates).eq('id', 1));
    } else {
      ({ error } = await sb.from('raice_config').insert({ id: 1, ...updates }));
    }
    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'config', `Configuración actualizada`);
    return res.status(200).json({ success: true });
  }

  const { data } = await sb.from('raice_config').select('*').eq('id', 1).maybeSingle();
  const config = data || {};
  // Parse periods_config if it's a JSON string
  if (config.periods_config && typeof config.periods_config === 'string') {
    try { config.periods_config = JSON.parse(config.periods_config); } catch (_) {}
  }
  return res.status(200).json(config);
}
  static async function handleRealtimeConfig(req, res, user) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!url || !key) {
    // Return 200 with error info to avoid polluting console with 500s
    return res.status(200).json({ ok: false, error: 'Realtime no configurado en variables de entorno' });
  }
  return res.status(200).json({ ok: true, supabase_url: url, supabase_anon_key: key });
}
  static async function handleSecurityConfig(req, res, user) {
  requireRole(user, 'superadmin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { new_password, session_timeout } = req.body || {};

  // Save timeout to config
  const updates = { session_timeout: session_timeout || 60 };
  const { data: existing } = await sb.from('raice_config').select('id').eq('id', 1).maybeSingle();
  if (existing) await sb.from('raice_config').update(updates).eq('id', 1);
  else          await sb.from('raice_config').insert({ id: 1, ...updates });

  // Change password if provided
  if (new_password && new_password.length >= 6) {
    const hash = await bcrypt.hash(new_password, 10);
    const { error } = await sb.from('raice_users').update({ password_hash: hash }).eq('id', user.id);
    if (error) return res.status(500).json({ error: 'Error al cambiar contraseña' });
    await logActivity(sb, user.id, 'config', 'Contraseña de superadmin actualizada');
  }

  await logActivity(sb, user.id, 'config', `Seguridad actualizada — timeout: ${session_timeout}min`);
  return res.status(200).json({ success: true });
}
  static async function handleLogs(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'GET') return res.status(405).end();
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type  = url.searchParams.get('type')  || '';
  const limit = parseInt(url.searchParams.get('limit')) || 100;

  let query = sb.from('raice_logs')
    .select('id, event_type, detail, created_at, raice_users(first_name, last_name, username)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (type) query = query.eq('event_type', type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: _dbErr(error, '') });

  const logs = (data || []).map(l => ({
    id:         l.id,
    event_type: l.event_type,
    detail:     l.detail,
    created_at: l.created_at,
    user_name:  l.raice_users ? `${l.raice_users.first_name} ${l.raice_users.last_name}` : 'Sistema',
    username:   l.raice_users?.username || '—'
  }));

  return res.status(200).json({ logs });
}
  static async function handlePeriods(req, res, user) {
  const sb = getSupabase();
  if (req.method === 'GET') {
    const { data } = await sb.from('raice_periods').select('*').order('year').order('period_num');
    return res.status(200).json({ periods: data || [] });
  }
  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { name, start_date, end_date, year, period_num, active } = req.body || {};
    if (!name || !start_date || !end_date) return res.status(400).json({ error: 'Datos incompletos' });
    if (active) await sb.from('raice_periods').update({ active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await sb.from('raice_periods').insert({ name, start_date, end_date, year: parseInt(year), period_num: parseInt(period_num), active: !!active }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, period: data });
  }
  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, name, start_date, end_date, year, period_num, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (name       !== undefined) updates.name       = name;
    if (start_date !== undefined) updates.start_date = start_date;
    if (end_date   !== undefined) updates.end_date   = end_date;
    if (year       !== undefined) updates.year       = parseInt(year);
    if (period_num !== undefined) updates.period_num = parseInt(period_num);
    if (active     !== undefined) {
      updates.active = !!active;
      if (active) await sb.from('raice_periods').update({ active: false }).neq('id', id);
    }
    const { error } = await sb.from('raice_periods').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }
  return res.status(405).end();
}
  static async function syncPeriods(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { year, periods } = req.body || {};
  if (!year || !Array.isArray(periods)) return res.status(400).json({ error: 'Datos incompletos' });

  const toInsert = periods
    .map((p, i) => ({
      name:       p.name || (i+1) + '° Período',
      year:       parseInt(year),
      period_num: i + 1,
      start_date: p.start || null,
      end_date:   p.end   || null,
      active:     i === 0
    }))
    .filter(p => p.start_date && p.end_date);

  // Safety check: never delete existing data if there's nothing valid to insert
  if (toInsert.length === 0) {
    return res.status(400).json({ error: 'Ningún período tiene fechas válidas de inicio y fin. No se realizaron cambios.' });
  }

  // Delete all periods for this year then recreate
  await sb.from('raice_periods').delete().eq('year', parseInt(year));

  const { error } = await sb.from('raice_periods').insert(toInsert);
  if (error) return res.status(500).json({ error: _dbErr(error) });

  await logActivity(sb, user.id, 'sync_periods', `${toInsert.length} períodos sincronizados para ${year}`);
  return res.status(200).json({ success: true, synced: toInsert.length });
}
  static async function handleBellSchedule(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'GET') {
    const { data } = await sb.from('raice_bell_schedule')
      .select('*').order('class_hour');
    return res.status(200).json({ bell_schedule: data || [] });
  }

  requireRole(user, 'superadmin');

  if (req.method === 'POST') {
    const { class_hour, start_time, end_time, label } = req.body || {};
    if (!class_hour) return res.status(400).json({ error: 'Número de hora requerido' });
    const { error } = await sb.from('raice_bell_schedule').upsert(
      {
        class_hour,
        start_time: start_time || null,
        end_time:   end_time   || null,
        label:      label      || null
      },
      { onConflict: 'class_hour' }
    );
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    const { class_hour } = req.body || {};
    if (!class_hour) return res.status(400).json({ error: 'Número de hora requerido' });
    const { error } = await sb.from('raice_bell_schedule').delete().eq('class_hour', class_hour);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}
  static async function handleFaltasCatalogo(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const tipo     = url.searchParams.get('tipo');
    const soloActivas = url.searchParams.get('activas') !== 'false';
    let q = sb.from('raice_faltas_catalogo').select('*').order('tipo').order('categoria').order('orden');
    if (tipo)        q = q.eq('tipo', parseInt(tipo));
    if (soloActivas) q = q.eq('activa', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Error al cargar catálogo' });
    // Sort by numeric parts of numeral (e.g. "1.10" > "1.9") since DB stores as text
    const sorted = (data || []).sort((a, b) => {
      if (a.tipo !== b.tipo) return a.tipo - b.tipo;
      if (a.categoria !== b.categoria) return a.categoria.localeCompare(b.categoria);
      const [aM, am] = a.numeral.split('.').map(Number);
      const [bM, bm] = b.numeral.split('.').map(Number);
      return aM !== bM ? aM - bM : (am || 0) - (bm || 0);
    });
    // Deduplicate by tipo+categoria+numeral (keep first occurrence / lowest id)
    const seen = new Set();
    const unique = sorted.filter(f => {
      const key = `${f.tipo}-${f.categoria}-${f.numeral}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return res.status(200).json({ faltas: unique });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin');
    const { tipo, categoria, numeral, descripcion, orden } = req.body || {};
    if (!tipo || !categoria || !numeral || !descripcion)
      return res.status(400).json({ error: 'Datos incompletos' });
    const { data, error } = await sb.from('raice_faltas_catalogo')
      .insert({ tipo, categoria, numeral, descripcion, orden: orden || 0 }).select().single();
    if (error) return res.status(500).json({ error: 'Error al crear falta' });
    return res.status(200).json({ success: true, falta: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin');
    const { id, descripcion, activa, orden } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (descripcion !== undefined) updates.descripcion = descripcion;
    if (activa      !== undefined) updates.activa      = activa;
    if (orden       !== undefined) updates.orden       = orden;
    const { error } = await sb.from('raice_faltas_catalogo').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al actualizar falta' });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // Check if this falta is referenced in any case before deleting
    const { count } = await sb.from('raice_cases')
      .select('id', { count: 'exact', head: true }).eq('falta_id', id);
    if (count > 0) {
      return res.status(409).json({
        error: `Esta falta está referenciada en ${count} caso(s). Desactívala en lugar de eliminarla.`
      });
    }
    const { error } = await sb.from('raice_faltas_catalogo').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar falta' });
    await logActivity(sb, user.id, 'delete_falta', `Falta eliminada: ${id}`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}
  static async function handleTipo1Escalones(req, res, user) {
  const sb = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    const case_id = url.searchParams.get('case_id');
    if (!case_id) return res.status(400).json({ error: 'case_id requerido' });

    // Verify access: teacher owns the case OR coordinator/superadmin
    if (user.role === 'teacher') {
      const { data: c } = await sb.from('raice_cases').select('teacher_id').eq('id', case_id).single();
      if (!c || c.teacher_id !== user.id)
        return res.status(403).json({ error: 'Sin acceso a este caso' });
    }

    const { data, error } = await sb.from('raice_tipo1_escalones')
      .select('*').eq('case_id', case_id).order('numero_escalon');
    if (error) return res.status(500).json({ error: 'Error al cargar escalones' });
    return res.status(200).json({ escalones: data || [] });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin', 'teacher');
    const { case_id, descripcion, descargos, compromiso, compromiso_fecha, garante } = req.body || {};
    if (!case_id || !descripcion) return res.status(400).json({ error: 'Datos incompletos' });

    // Verify teacher owns this case
    const { data: caseRow } = await sb.from('raice_cases')
      .select('teacher_id, type, status, student_name, grade, course').eq('id', case_id).single();
    if (!caseRow) return res.status(404).json({ error: 'Caso no encontrado' });
    if (user.role === 'teacher' && caseRow.teacher_id !== user.id)
      return res.status(403).json({ error: 'No eres el docente de este caso' });
    if (caseRow.type !== 1)
      return res.status(400).json({ error: 'Solo casos Tipo I tienen escalones' });
    if (caseRow.status === 'escalado')
      return res.status(400).json({ error: 'Este caso ya fue escalado a Tipo II' });
    if (caseRow.status === 'closed' && !isCierre)
      return res.status(400).json({ error: 'Este caso ya fue cerrado como resuelto' });

    // Determine next escalon number
    // Determine if this is a closure entry FIRST (before any checks that use isCierre)
    const isCierre = req.body?._cierre === true;

    const { count } = await sb.from('raice_tipo1_escalones')
      .select('id', { count: 'exact', head: true }).eq('case_id', case_id);
    const numero_escalon = (count || 0) + 1;

    if (!isCierre && numero_escalon > 4)
      return res.status(400).json({ error: 'Máximo 4 escalones. Debe escalar a Tipo II.' });
    if (isCierre && numero_escalon > 5)
      return res.status(400).json({ error: 'Caso ya cerrado' });

    const tipoMap = { 1:'verbal', 2:'escrito', 3:'escrito_con_mediador', 4:'citacion_acudiente' };
    const tipo_llamado = isCierre ? 'cierre' : tipoMap[numero_escalon];

    const { data: escalon, error } = await sb.from('raice_tipo1_escalones').insert({
      case_id, numero_escalon, tipo_llamado,
      descripcion, descargos: descargos || null,
      compromiso: compromiso || null,
      compromiso_fecha: compromiso_fecha || null,
      garante: garante || null,
      created_by: user.id,
    }).select().single();

    if (error) return res.status(500).json({ error: 'Error al registrar escalón' });

    // After escalon 4 → mark case as escalated to Tipo II (skip for cierre)
    let escalado = false;
    if (!isCierre && numero_escalon === 4) {
      await sb.from('raice_cases').update({ status: 'escalado', type: 2 }).eq('id', case_id);
      escalado = true;
      // Notify coordinators that it now requires action
      const { data: admins } = await sb.from('raice_users').select('id').eq('role','admin').eq('active',true);
      for (const admin of (admins||[])) {
        await sendNotification(sb, admin.id, user.id, 'new_case',
          `Caso escalado a Tipo II — ${caseRow.student_name}`,
          `Agotó proceso Tipo I · ${caseRow.grade}°${caseRow.course} · Requiere intervención`,
          case_id);
      }
    } else if (!isCierre) {
      // Informative notification for escalones 1-3
      const escalLabels = {1:'Llamado verbal',2:'1er llamado escrito',3:'2do llamado escrito'};
      const { data: admins } = await sb.from('raice_users').select('id').eq('role','admin').eq('active',true);
      for (const admin of (admins||[])) {
        await sendNotification(sb, admin.id, user.id, 'info_tipo1',
          `[Informativo] ${escalLabels[numero_escalon]} — ${caseRow.student_name}`,
          `Escalón ${numero_escalon} registrado · ${caseRow.grade}°${caseRow.course}`,
          case_id);
      }
    }

    await logActivity(sb, user.id, 'tipo1_escalon',
      `Escalón ${numero_escalon} (${tipo_llamado}) registrado en caso ${case_id}`);

    return res.status(200).json({ success: true, escalon, escalado });
  }

  return res.status(405).end();
}
  static async function handleYearRollover(req, res, user) {
  requireRole(user, 'superadmin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    const [studentsRes, coursesRes, configRes] = await Promise.all([
      sb.from('raice_students')
        .select('id, first_name, last_name, grade, course, course_id, status')
        .eq('status', 'active')
        .order('grade').order('course').order('last_name'),
      sb.from('raice_courses')
        .select('id, grade, number')
        .order('grade').order('number'),
      sb.from('raice_config').select('year').eq('id', 1).maybeSingle()
    ]);
    return res.status(200).json({
      students:     studentsRes.data || [],
      courses:      coursesRes.data  || [],
      current_year: configRes.data?.year || new Date().getFullYear()
    });
  }

  if (req.method === 'POST') {
    const { new_year, promotions } = req.body || {};

    // Validaciones de entrada
    const yearNum = parseInt(new_year, 10);
    if (!yearNum || yearNum < 2020 || yearNum > 2100)
      return res.status(400).json({ error: 'new_year debe ser un año válido (2020-2100)' });
    if (!Array.isArray(promotions) || promotions.length === 0)
      return res.status(400).json({ error: 'promotions debe ser un arreglo no vacío' });

    const VALID_ACTIONS = new Set(['promote', 'retain', 'graduate', 'retire']);

    const summary = { promoted: 0, retained: 0, graduated: 0, retired: 0, errors: [] };

    const { data: courses } = await sb.from('raice_courses').select('id, grade, number');
    const courseMap = {};
    (courses || []).forEach(c => { courseMap[c.id] = c; });

    for (const p of promotions) {
      const { student_id, action, to_course_id } = p;

      // Validar campos por fila
      if (!student_id || typeof student_id !== 'string') {
        summary.errors.push(`student_id inválido: ${student_id}`); continue;
      }
      if (!VALID_ACTIONS.has(action)) {
        summary.errors.push(`Acción inválida '${action}' para ${student_id}`); continue;
      }
      try {
        if (action === 'graduate') {
          await sb.from('raice_students').update({ status: 'graduated' }).eq('id', student_id);
          summary.graduated++;
        } else if (action === 'retire') {
          await sb.from('raice_students').update({ status: 'retired' }).eq('id', student_id);
          summary.retired++;
        } else if (action === 'promote' || action === 'retain') {
          if (!to_course_id) { summary.errors.push(`Sin curso destino: ${student_id}`); continue; }
          const { data: student } = await sb.from('raice_students')
            .select('grade, course, course_id').eq('id', student_id).single();
          if (!student) continue;
          const target = courseMap[to_course_id];
          if (!target) { summary.errors.push(`Curso no encontrado: ${to_course_id}`); continue; }
          await sb.from('raice_students').update({
            course_id: to_course_id,
            grade:     target.grade,
            course:    target.number
          }).eq('id', student_id);
          await sb.from('raice_student_grade_history').insert({
            student_id,
            from_grade:    student.grade,
            from_course:   student.course,
            from_course_id: student.course_id,
            to_grade:      target.grade,
            to_course:     target.number,
            to_course_id,
            reason:        action === 'promote' ? 'promotion' : 'other',
            notes:         action === 'promote'
                             ? `Promoción año ${new_year}`
                             : `Repitencia año ${new_year}`,
            changed_by:   user.id,
            changed_at:   new Date().toISOString()
          });
          if (action === 'promote') summary.promoted++;
          else summary.retained++;
        }
      } catch (err) {
        summary.errors.push(`${student_id}: ${err.message}`);
      }
    }

    // Update year in config
    await sb.from('raice_config').update({ year: new_year }).eq('id', 1);

    await logActivity(sb, user.id, 'year_rollover',
      `Inicio año ${new_year}: ${summary.promoted} promovidos, ${summary.retained} repitentes, ${summary.graduated} egresados, ${summary.retired} retirados`);

    return res.status(200).json({ success: true, summary, new_year });
  }

  return res.status(405).end();
}

}
