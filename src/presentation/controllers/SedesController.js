import { getSupabase } from '../../data/supabaseClient.js';
import { requireRole, logActivity, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, _dbErr, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';
import { todayCO, dayOfWeekCO } from '../../shared/utils/date.js';
import { checkRateLimit, checkRateLimitPortal, verifyToken } from '../../shared/utils/authHelpers.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export class SedesController {
  static async handleSedes(...args) {
    return await handleSedes(...args);
  }
}

async function handleSedes(req, res, user) {
  requireRole(user, 'superadmin', 'admin', 'rector');
  const sb  = getSupabase();
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET') {
    let query = sb.from('raice_sedes')
      .select('id, name, type, address, active, created_at')
      .order('name');

    if (user.role === 'admin') {
      const adminSedeIds = await getAdminSedeIds(sb, user);
      if (adminSedeIds && adminSedeIds.length > 0) {
        query = query.in('id', adminSedeIds);
      } else {
        query = query.in('id', ['00000000-0000-0000-0000-000000000000']);
      }
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Error al cargar sedes' });
    const sedes = data || [];

    // stats=true: añade conteos de estudiantes, casos activos y asistencia de hoy por sede
    if (url.searchParams.get('stats') === 'true' && sedes.length) {
      const today    = todayCO().split('T')[0];
      const sedeIds  = sedes.map(s => s.id);

      // 1. Cursos por sede
      const { data: courseRows } = await sb.from('raice_courses')
        .select('id, sede_id').in('sede_id', sedeIds).neq('type', 'subgroup');
      const allCourseIds = (courseRows || []).map(c => c.id);
      const courseSedeMap = {};
      (courseRows || []).forEach(c => { courseSedeMap[c.id] = c.sede_id; });

      // 2. Contar estudiantes activos por sede
      const studentsMap = {};
      if (allCourseIds.length) {
        const { data: stRows } = await sb.from('raice_students')
          .select('course_id').in('course_id', allCourseIds).eq('status', 'active');
        (stRows || []).forEach(s => {
          const sid = courseSedeMap[s.course_id];
          if (sid) studentsMap[sid] = (studentsMap[sid] || 0) + 1;
        });
      }

      // 3. Asistencia de hoy por sede
      const attMap = {};
      if (allCourseIds.length) {
        const { data: attRows } = await sb.from('raice_attendance')
          .select('course_id, status').in('course_id', allCourseIds).eq('date', today);
        (attRows || []).forEach(r => {
          const sid = courseSedeMap[r.course_id];
          if (!sid) return;
          if (!attMap[sid]) attMap[sid] = { P:0, A:0, T:0, E:0 };
          attMap[sid][r.status] = (attMap[sid][r.status] || 0) + 1;
        });
      }

      // 4. Casos activos por sede
      const casesMap = {};
      if (allCourseIds.length) {
        const { data: caseRows } = await sb.from('raice_cases')
          .select('course_id').in('course_id', allCourseIds).eq('status', 'open');
        (caseRows || []).forEach(c => {
          const sid = courseSedeMap[c.course_id];
          if (sid) casesMap[sid] = (casesMap[sid] || 0) + 1;
        });
      }

      const sedesWithStats = sedes.map(s => ({
        ...s,
        students:     studentsMap[s.id] || 0,
        att_today:    attMap[s.id]      || { P:0, A:0, T:0, E:0 },
        active_cases: casesMap[s.id]   || 0,
      }));
      return res.status(200).json({ sedes: sedesWithStats });
    }

    return res.status(200).json({ sedes });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin');
    const { name, type, address } = req.body || {};
    if (!name) return res.status(400).json({ error: 'El nombre de la sede es requerido' });
    const { data, error } = await sb.from('raice_sedes')
      .insert({ name, type: type || 'mixta', address: address || null })
      .select().single();
    if (error) return res.status(500).json({ error: 'Error al crear sede' });
    await logActivity(sb, user.id, 'create_sede', `Sede creada: ${name}`);
    return res.status(200).json({ success: true, sede: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin');
    const { id, name, type, address, active } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const updates = {};
    if (name    !== undefined) updates.name    = name;
    if (type    !== undefined) updates.type    = type;
    if (address !== undefined) updates.address = address;
    if (active  !== undefined) updates.active  = active;
    const { error } = await sb.from('raice_sedes').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al actualizar sede' });
    await logActivity(sb, user.id, 'update_sede', `Sede ${id} actualizada`);
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    const [uCount, cCount] = await Promise.all([
      sb.from('raice_users').select('id', { count: 'exact', head: true }).eq('sede_id', id),
      sb.from('raice_courses').select('id', { count: 'exact', head: true }).eq('sede_id', id),
    ]);
    if ((uCount.count || 0) + (cCount.count || 0) > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar: la sede tiene usuarios o cursos asignados',
        refs: { users: uCount.count || 0, courses: cCount.count || 0 }
      });
    }
    const { error } = await sb.from('raice_sedes').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Error al eliminar sede' });
    await logActivity(sb, user.id, 'delete_sede', `Sede ${id} eliminada`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
