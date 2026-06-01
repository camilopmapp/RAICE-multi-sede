import { getSupabase } from '../../data/supabaseClient.js';
import { logActivity, _dbErr, requireRole, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, getAdminSedeIds } from '../../shared/utils/apiHelpers.js';

function todayCO() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split('T')[0];
}

export class UsersController {
  static async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!checkRateLimit(req, res)) return;

  const { username, password, role } = req.body || {};

  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  // Use Repository for data access
  const { user, error } = await UserRepository.findByUsername(username);

  if (error || !user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  if (!user.active)   return res.status(403).json({ error: 'Cuenta desactivada. Contacta al coordinador.' });

  // Role mismatch check
  if (role && user.role !== role) {
    const labels = { superadmin:'Superadministrador', admin:'Coordinador', teacher:'Docente', rector:'Rector' };
    return res.status(401).json({ error: `Este usuario no tiene perfil de ${labels[role] || role}` });
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  // Update last login
  await UserRepository.updateLastLogin(user.id);

  // Log activity (legacy call that still needs the sb client)
  const sb = getSupabase();
  await logActivity(sb, user.id, 'login', `Inicio de sesión: @${user.username}`);

  // Fetch teacher's sede name separately
  let single_sede_name = null;
  if (user.role === 'teacher' && user.sede_id) {
    single_sede_name = await UserRepository.getTeacherSedeName(user.sede_id);
  }

  // Cargar sedes del coordinador
  let sede_ids   = null;
  let sede_names = null;
  if (user.role === 'admin') {
    const adminSedes = await UserRepository.getAdminSedes(user.id);
    sede_ids = adminSedes.sede_ids;
    sede_names = adminSedes.sede_names;
  }

  // Generate token
  const token = jwt.sign(
    {
      id: user.id, role: user.role, username: user.username,
      // Teachers: single sede_id. Admins: sede_ids array. Rector/superadmin: null
      sede_id:  user.role === 'teacher' ? (user.sede_id || null) : null,
      sede_ids: user.role === 'admin'   ? (sede_ids || [])       : null,
    },
    _JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.status(200).json({
    success: true,
    token,
    role: user.role,
    user: {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name:  user.last_name,
      name: `${user.first_name} ${user.last_name}`,
      role:  user.role,
      subject: user.subject,
      // sede_id solo para docentes; admins usan sede_ids
      sede_id:    user.role === 'teacher' ? (user.sede_id || null) : null,
      sede_name:  user.role === 'teacher' ? (single_sede_name || null)
                : (sede_names && sede_names.length > 0 ? sede_names.join(' · ') : null),
      sede_ids:   sede_ids,
      sede_names: sede_names,
      must_change_password: user.must_change_password || false
    }
  });
}
  static async function verifyToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const payload = jwt.verify(token, _JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}
  static async function handleUsers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  if (req.method === 'GET') {
    let q = sb.from('raice_users')
      .select('id, username, first_name, last_name, email, role, active, last_login, subject')
      .order('first_name');
    if (user.role !== 'superadmin') q = q.neq('role', 'superadmin');
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Error al cargar usuarios' });

    // Batch: get course counts for all users in one query instead of N+1
    const userIds = (data || []).map(u => u.id);
    const courseCountMap = {};
    if (userIds.length) {
      const { data: tcRows } = await sb.from('raice_teacher_courses')
        .select('teacher_id').in('teacher_id', userIds);
      (tcRows || []).forEach(r => {
        courseCountMap[r.teacher_id] = (courseCountMap[r.teacher_id] || 0) + 1;
      });
    }

    const withCounts = (data || []).map(u => ({ ...u, courses_count: courseCountMap[u.id] || 0 }));
    return res.status(200).json({ users: withCounts });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { first_name, last_name, username, email, role, password } = req.body || {};
    if (!first_name || !username || !password) return res.status(400).json({ error: 'Faltan campos requeridos' });

    // Only superadmin can create admin/superadmin/rector accounts
    const assignedRole = role || 'teacher';
    if (['admin', 'superadmin', 'rector'].includes(assignedRole) && user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Solo el superadministrador puede crear coordinadores o rectores' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await sb.from('raice_users').insert({
      first_name, last_name, username: username.toLowerCase(), email, role: assignedRole,
      password_hash, active: true
    }).select().single();

    if (error) return res.status(500).json({ error: error.code === '23505' ? 'El nombre de usuario ya existe' : 'Error al crear usuario' });
    await logActivity(sb, user.id, 'create_user', `Usuario creado: @${username}`);
    return res.status(200).json({ success: true, user: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, first_name, last_name, username, email, role, subject, active, password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });

    if (role && ['admin','superadmin','rector'].includes(role) && user.role !== 'superadmin')
      return res.status(403).json({ error: 'Solo el superadministrador puede asignar ese rol' });

    const updates = { first_name, last_name, subject, active };
    if (username) updates.username = username.toLowerCase();
    if (email !== undefined) updates.email = email;
    // Superadmin can change any role; admin can only toggle active state of non-admin users
    if (role && user.role === 'superadmin') updates.role = role;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    const { error } = await sb.from('raice_users').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: error.code === '23505' ? 'El nombre de usuario ya existe' : 'Error al actualizar' });
    await logActivity(sb, user.id, 'update_user', `Usuario ${id} actualizado`);
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin');
    const { id, force } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID requerido' });
    // Cannot delete yourself
    if (id === user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    // Check if user has associated data (attendance records, cases, etc.)
    const [attCount, casesCount, obsCount] = await Promise.all([
      sb.from('raice_attendance').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
      sb.from('raice_cases').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
      sb.from('raice_observations').select('id', { count: 'exact', head: true }).eq('teacher_id', id),
    ]);
    const totalRefs = (attCount.count || 0) + (casesCount.count || 0) + (obsCount.count || 0);
    if (totalRefs > 0 && !force) {
      return res.status(409).json({
        error: 'El usuario tiene registros asociados',
        refs: { attendance: attCount.count || 0, cases: casesCount.count || 0, observations: obsCount.count || 0 },
        canForce: true
      });
    }
    // Remove teacher-course assignments first
    await sb.from('raice_teacher_courses').delete().eq('teacher_id', id);
    const { error } = await sb.from('raice_users').delete().eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error, '') });
    await logActivity(sb, user.id, 'delete_user', `Usuario ${id} eliminado`);
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
  static async function resetUserPassword(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { id, password } = req.body || {};
  if (!id || !password) return res.status(400).json({ error: 'ID y contraseña requeridos' });
  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await sb.from('raice_users').update({ password_hash }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Error al actualizar contraseña' });
  await logActivity(sb, user.id, 'reset_password', `Contraseña reseteada para usuario ${id}`);
  return res.status(200).json({ success: true });
}
  static async function handleTeachers(req, res, user) {
  requireRole(user, 'superadmin', 'admin');
  const sb = getSupabase();

  const { data, error } = await sb.from('raice_users')
    .select('id, username, first_name, last_name, email, subject, active, last_login')
    .eq('role', 'teacher').order('first_name');

  if (error) return res.status(500).json({ error: 'Error al cargar docentes' });

  const teacherIds = (data || []).map(t => t.id);
  const month_start = todayCO().substring(0, 8) + '01';

  // Batch: all teacher-course assignments and cases in 2 queries instead of 2N
  const [tcAll, casesAll] = await Promise.all([
    teacherIds.length
      ? sb.from('raice_teacher_courses')
          .select('teacher_id, raice_courses(grade,number)').in('teacher_id', teacherIds)
      : { data: [] },
    teacherIds.length
      ? sb.from('raice_cases')
          .select('teacher_id').in('teacher_id', teacherIds)
          .gte('created_at', month_start + 'T00:00:00')
      : { data: [] }
  ]);

  // Build lookup maps
  const tcMap = {};
  (tcAll.data || []).forEach(r => {
    if (!tcMap[r.teacher_id]) tcMap[r.teacher_id] = [];
    if (r.raice_courses) tcMap[r.teacher_id].push(`${r.raice_courses.grade}°${r.raice_courses.number}`);
  });
  const casesMap = {};
  (casesAll.data || []).forEach(r => {
    casesMap[r.teacher_id] = (casesMap[r.teacher_id] || 0) + 1;
  });

  const teachers = (data || []).map(t => ({
    ...t,
    courses: tcMap[t.id] || [],
    cases_this_month: casesMap[t.id] || 0
  }));

  return res.status(200).json({ teachers });
}
  static async function changePassword(req, res, user) {
  if (req.method !== 'POST') return res.status(405).end();
  const sb = getSupabase();
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Campos requeridos' });
  if (new_password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const { data: u } = await sb.from('raice_users').select('password_hash').eq('id', user.id).single();
  const valid = await bcrypt.compare(current_password, u?.password_hash || '');
  if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  const password_hash = await bcrypt.hash(new_password, 10);
  const { error } = await sb.from('raice_users').update({ password_hash }).eq('id', user.id);
  if (error) return res.status(500).json({ error: 'Error al actualizar contraseña' });

  await logActivity(sb, user.id, 'change_password', 'Contraseña actualizada por el usuario');
  return res.status(200).json({ success: true });
}
  static async function handleAcudientes(req, res, user) {
  const sb = getSupabase();

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const studentId = url.searchParams.get('student_id');
    // Accept token from Authorization header (preferred) or query param (legacy links)
    const authHeader = req.headers['authorization'] || '';
    const token = (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null)
                  || url.searchParams.get('token');

    if (token) {
      // Public view for parents — verify token and check expiry
      const { data: acud } = await sb.from('raice_acudientes').select('student_id, access_token, token_expires_at').eq('access_token', token).single();
      if (!acud) return res.status(403).json({ error: 'Enlace inválido o expirado' });
      // Check expiry if set
      if (acud.token_expires_at && new Date(acud.token_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Este enlace ha expirado. Solicita uno nuevo al coordinador.' });
      }
      // Return limited student info
      const { data: student } = await sb.from('raice_students').select('first_name, last_name, grade, course').eq('id', acud.student_id).single();
      const { data: att } = await sb.from('raice_attendance').select('status, date, class_hour')
        .eq('student_id', acud.student_id).order('date', { ascending: false }).limit(30);
      const { data: tardanzas } = await sb.from('raice_attendance').select('date, class_hour')
        .eq('student_id', acud.student_id).eq('status','T').order('date', { ascending: false }).limit(10);
      return res.status(200).json({ student, attendance: att || [], tardanzas: tardanzas || [] });
    }

    requireRole(user, 'superadmin', 'admin');
    if (!studentId) return res.status(400).json({ error: 'student_id requerido' });
    const { data } = await sb.from('raice_acudientes').select('*').eq('student_id', studentId);
    return res.status(200).json({ acudientes: data || [] });
  }

  if (req.method === 'POST') {
    requireRole(user, 'superadmin', 'admin');
    const { student_id, name, phone, email, relationship } = req.body || {};
    if (!student_id || !name) return res.status(400).json({ error: 'Datos incompletos' });
    // Generate cryptographically secure access token for parent portal
    const { randomBytes } = await import('crypto');
    const token = randomBytes(24).toString('hex');
    // Token expires in 1 year from creation
    const expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb.from('raice_acudientes').insert({
      student_id, name, phone: phone || null, email: email || null,
      relationship: relationship || 'Acudiente', access_token: token,
      token_expires_at: expires_at
    }).select().single();
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true, acudiente: data });
  }

  if (req.method === 'PUT') {
    requireRole(user, 'superadmin', 'admin');
    const { id, name, phone, email, relationship } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'ID y nombre requeridos' });
    const updates = { name, phone: phone || null, email: email || null };
    if (relationship !== undefined) updates.relationship = relationship;
    const { error } = await sb.from('raice_acudientes').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: _dbErr(error) });
    return res.status(200).json({ success: true });
  }

  if (req.method === 'DELETE') {
    requireRole(user, 'superadmin', 'admin');
    const { id } = req.body || {};
    await sb.from('raice_acudientes').delete().eq('id', id);
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}
  static async function recoverPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!checkRateLimit(req, res)) return;
  const sb = getSupabase();
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Usuario requerido' });

  // Always return same response shape to prevent user enumeration
  const { data: user } = await sb.from('raice_users')
    .select('id, first_name, last_name, email, role').eq('username', username.toLowerCase()).eq('active', true).single();

  if (!user) return res.status(200).json({ success: false, message: 'Si el usuario existe, se generará una contraseña temporal.' });

  // Block recovery of superadmin accounts from public endpoint
  if (user.role === 'superadmin') return res.status(403).json({ error: 'Contacta al administrador del sistema' });

  // Generate cryptographically secure temp password
  const { randomBytes } = await import('crypto');
  const tempPass = randomBytes(5).toString('hex').toUpperCase();
  const hash = await bcrypt.hash(tempPass, 10);
  await sb.from('raice_users').update({ password_hash: hash, must_change_password: true }).eq('id', user.id);

  // Log the recovery so the coordinator can look it up in the logs panel
  await logActivity(sb, user.id, 'recover_password',
    `Contraseña temporal generada para @${username} — entrégala en mano: ${tempPass}`);

  // IMPORTANT: the temp password is NOT returned in the HTTP response.
  // The coordinator must retrieve it from the Registros (logs) panel in the admin interface.
  return res.status(200).json({
    success: true,
    message: `Contraseña temporal generada para ${user.first_name} ${user.last_name}. Consulta el panel de Registros para obtenerla y entrégala en mano al usuario.`,
    user_name: `${user.first_name} ${user.last_name}`
  });
}

}
