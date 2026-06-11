/**
 * shared/data/repositories.js
 * Funciones de acceso a datos (repositories).
 * Cada función recibe el cliente API (fetchAPI/api) y retorna datos limpios.
 * NO manipulan DOM ni tienen side-effects visuales.
 */
(function(R) {

// ── Config & School ─────────────────────────────────────
R.fetchConfig = async function(apiFn) {
  var r = await apiFn('/raice/config');
  return r.ok ? r.data : null;
};

R.fetchSedes = async function(apiFn, opts) {
  var path = '/raice/sedes' + (opts && opts.stats ? '?stats=true' : '');
  var r = await apiFn(path);
  return r.ok ? (r.data.sedes || []) : [];
};

// ── Dashboard ───────────────────────────────────────────
R.fetchDashboard = async function(apiFn) {
  var r = await apiFn('/raice/dashboard');
  return r.ok ? r.data : null;
};

R.fetchAlerts = async function(apiFn) {
  var r = await apiFn('/raice/alerts');
  return r.ok ? (r.data.alerts || []) : [];
};

R.fetchTeacherAbsences = async function(apiFn) {
  var r = await apiFn('/raice/teacher-absences');
  return r.ok ? (r.data.absences || []) : [];
};

// ── Students ────────────────────────────────────────────
R.fetchStudents = async function(apiFn) {
  var r = await apiFn('/raice/students');
  if (!r.ok) return [];
  return r.data.students || r.data || [];
};

R.fetchStudentFicha = async function(apiFn, studentId, allObs, periodId) {
  var path = '/raice/student-ficha?id=' + studentId;
  if (allObs) path += '&all_obs=1';
  if (periodId) path += '&period_id=' + encodeURIComponent(periodId);
  var r = await apiFn(path);
  return r.ok ? r.data : null;
};

// ── Cases ───────────────────────────────────────────────
R.fetchCases = async function(apiFn) {
  var r = await apiFn('/raice/cases');
  return r.ok ? (r.data.cases || []) : [];
};

// ── Teachers ────────────────────────────────────────────
R.fetchTeachers = async function(apiFn) {
  var r = await apiFn('/raice/teachers');
  return r.ok ? (r.data.teachers || []) : [];
};

// ── Periods ─────────────────────────────────────────────
R.fetchPeriods = async function(apiFn) {
  var r = await apiFn('/raice/periods');
  return r.ok ? (r.data.periods || []) : [];
};

// ── Schedules ───────────────────────────────────────────
R.fetchSchedulesOverview = async function(apiFn) {
  var r = await apiFn('/raice/schedules/overview');
  if (!r.ok) return { schedules: [], bell_schedule: [], today: null, today_dow: null };
  return {
    schedules: r.data.schedules || [],
    bell_schedule: r.data.bell_schedule || [],
    // El mapa escolar necesita today_dow (1=Lun..7=Dom) para saber qué cursos
    // están en clase HOY. Si no se reenvía, today_dow llega undefined y la vista
    // "Ahora mismo" muestra "undefined" y "No hay cursos con horario cargado".
    today:     r.data.today || null,
    today_dow: r.data.today_dow != null ? r.data.today_dow : null
  };
};

R.fetchBellSchedule = async function(apiFn) {
  var r = await apiFn('/raice/bell-schedule');
  return r.ok ? (r.data.bell_schedule || r.data || []) : [];
};

// ── Attendance ──────────────────────────────────────────
R.fetchAttendance = async function(apiFn, params) {
  var query = [];
  if (params) {
    if (params.date) query.push('date=' + params.date);
    if (params.course_id) query.push('course_id=' + params.course_id);
    if (params.from) query.push('from=' + params.from);
    if (params.to) query.push('to=' + params.to);
  }
  var path = '/raice/attendance' + (query.length ? '?' + query.join('&') : '');
  var r = await apiFn(path);
  return r.ok ? r.data : null;
};

// ── Excusas ─────────────────────────────────────────────
R.fetchExcusas = async function(apiFn, params) {
  var query = [];
  if (params) {
    if (params.from) query.push('from=' + params.from);
    if (params.to) query.push('to=' + params.to);
    if (params.course_id) query.push('course_id=' + params.course_id);
  }
  var path = '/raice/excusas' + (query.length ? '?' + query.join('&') : '');
  var r = await apiFn(path);
  return r.ok ? r.data : null;
};

// ── Calendar ────────────────────────────────────────────
R.fetchCalendar = async function(apiFn, year) {
  var r = await apiFn('/raice/calendar?year=' + (year || new Date().getFullYear()));
  return r.ok ? (r.data.events || []) : [];
};

// ── Users (superadmin) ──────────────────────────────────
R.fetchUsers = async function(apiFn) {
  var r = await apiFn('/raice/users');
  return r.ok ? (r.data.users || []) : [];
};

// ── Courses ─────────────────────────────────────────────
R.fetchCourses = async function(apiFn) {
  var r = await apiFn('/raice/courses');
  return r.ok ? (r.data.courses || []) : [];
};

// ── Acudientes ──────────────────────────────────────────
R.fetchAcudientes = async function(apiFn, studentId) {
  var r = await apiFn('/raice/acudientes?student_id=' + studentId);
  return r.ok ? (r.data.acudientes || []) : [];
};

// ── Auth ────────────────────────────────────────────────
R.changePassword = async function(apiFn, currentPwd, newPwd) {
  var r = await apiFn('/raice/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPwd, new_password: newPwd })
  });
  return { ok: r.ok, error: r.data?.error || null };
};

// ── Rector Insights ─────────────────────────────────────
R.fetchRectorInsights = async function(apiFn) {
  var r = await apiFn('/raice/rector-insights');
  return r.ok ? r.data : null;
};

// ══════════════════════════════════════════════════════════
// OPERACIONES DE ESCRITURA (CRUD compartido entre vistas)
// ══════════════════════════════════════════════════════════

// ── Cases CRUD ──────────────────────────────────────────
R.createCase = async function(apiFn, payload) {
  var r = await apiFn('/raice/cases', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.updateCaseStatus = async function(apiFn, id, status) {
  var r = await apiFn('/raice/cases', { method:'PUT', body: JSON.stringify({ id: id, status: status }) });
  return { ok: r.ok };
};

R.updateCaseType = async function(apiFn, id, type) {
  var r = await apiFn('/raice/cases', { method:'PUT', body: JSON.stringify({ id: id, type: type }) });
  return { ok: r.ok };
};

// ── Students CRUD ───────────────────────────────────────
R.createStudent = async function(apiFn, payload) {
  var r = await apiFn('/raice/students', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.updateStudent = async function(apiFn, payload) {
  var r = await apiFn('/raice/students', { method:'PUT', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteStudent = async function(apiFn, id) {
  var r = await apiFn('/raice/students', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Acudientes CRUD ─────────────────────────────────────
R.createAcudiente = async function(apiFn, payload) {
  var r = await apiFn('/raice/acudientes', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.updateAcudiente = async function(apiFn, payload) {
  var r = await apiFn('/raice/acudientes', { method:'PUT', body: JSON.stringify(payload) });
  return { ok: r.ok, error: r.data?.error };
};

R.deleteAcudiente = async function(apiFn, id) {
  var r = await apiFn('/raice/acudientes', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Attendance ──────────────────────────────────────────
R.saveAttendance = async function(apiFn, payload) {
  var r = await apiFn('/raice/attendance', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

// ── Excusas CRUD ────────────────────────────────────────
R.createExcusa = async function(apiFn, payload) {
  var r = await apiFn('/raice/excusas', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteExcusa = async function(apiFn, id) {
  var r = await apiFn('/raice/excusas', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Subgroup Members ────────────────────────────────────
R.addSubgroupMembers = async function(apiFn, subgroupId, studentIds) {
  var rows = studentIds.map(function(sid) { return { subgroup_course_id: subgroupId, student_id: sid }; });
  var r = await apiFn('/raice/subgroup-members', { method:'POST', body: JSON.stringify({ rows: rows }) });
  return { ok: r.ok, error: r.data?.error };
};

R.removeSubgroupMember = async function(apiFn, id) {
  var r = await apiFn('/raice/subgroup-members', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

// ══════════════════════════════════════════════════════════
// ENDPOINTS ESPECÍFICOS POR ROL
// ══════════════════════════════════════════════════════════

// ── Docente ─────────────────────────────────────────────
R.fetchMyCourses = async function(apiFn) {
  var r = await apiFn('/raice/my-courses');
  return r.ok ? r.data : null;
};

R.fetchMyCases = async function(apiFn) {
  var r = await apiFn('/raice/my-cases');
  return r.ok ? (r.data.cases || []) : [];
};

R.fetchMySchedule = async function(apiFn) {
  var r = await apiFn('/raice/my-schedule');
  return r.ok ? r.data : null;
};

R.fetchGradeCases = async function(apiFn) {
  var r = await apiFn('/raice/grade-cases');
  return r.ok ? r.data : null;
};

R.fetchCalendarToday = async function(apiFn) {
  var r = await apiFn('/raice/calendar/today');
  return r.ok ? r.data : null;
};

R.createObservation = async function(apiFn, payload) {
  var r = await apiFn('/raice/observations', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.submitClassroomRemoval = async function(apiFn, payload) {
  var r = await apiFn('/raice/classroom-removals', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Rector ──────────────────────────────────────────────
R.fetchSedesStats = async function(apiFn) {
  return await R.fetchSedes(apiFn, { stats: true });
};

// ── Superadmin ──────────────────────────────────────────
R.createUser = async function(apiFn, payload) {
  var r = await apiFn('/raice/users', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.updateUser = async function(apiFn, payload) {
  var r = await apiFn('/raice/users', { method:'PUT', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteUser = async function(apiFn, id, force) {
  var r = await apiFn('/raice/users', { method:'DELETE', body: JSON.stringify({ id: id, force: force }) });
  return { ok: r.ok, status: r.status, data: r.data, error: r.data?.error };
};

R.createCourse = async function(apiFn, payload) {
  var r = await apiFn('/raice/courses', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteCourse = async function(apiFn, id) {
  var r = await apiFn('/raice/courses', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

R.saveSede = async function(apiFn, payload, isNew) {
  var r = await apiFn('/raice/sedes', { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteSede = async function(apiFn, id) {
  var r = await apiFn('/raice/sedes', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Notifications ───────────────────────────────────────
R.fetchNotifications = async function(apiFn) {
  var r = await apiFn('/raice/notifications');
  return r.ok ? r.data : null;
};

R.markNotificationRead = async function(apiFn, id) {
  var r = await apiFn('/raice/notifications', { method:'PUT', body: JSON.stringify({ id: id, read: true }) });
  return { ok: r.ok };
};

R.deleteNotification = async function(apiFn, id) {
  var r = await apiFn('/raice/notifications', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok };
};

// ── Sedes CRUD ──────────────────────────────────────────
R.fetchSedesForSelect = async function(apiFn) {
  var r = await apiFn('/raice/sedes', { _skipSedeFilter: true });
  return r.ok ? (r.data.sedes || []) : [];
};

// ── Bell Schedule CRUD ──────────────────────────────────
R.saveBellHour = async function(apiFn, payload) {
  var r = await apiFn('/raice/bell-schedule', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, data: r.data, error: r.data?.error };
};

R.deleteBellHour = async function(apiFn, id) {
  var r = await apiFn('/raice/bell-schedule', { method:'DELETE', body: JSON.stringify({ id: id }) });
  return { ok: r.ok };
};

// ── Citations ───────────────────────────────────────────
R.fetchCitations = async function(apiFn) {
  var r = await apiFn('/raice/citations');
  return r.ok ? (r.data.citations || []) : [];
};

R.saveCitation = async function(apiFn, payload) {
  var r = await apiFn('/raice/citations', { method:'POST', body: JSON.stringify(payload) });
  return { ok: r.ok, error: r.data?.error };
};

// ── Commitments ─────────────────────────────────────────
R.fetchCommitments = async function(apiFn) {
  var r = await apiFn('/raice/commitments');
  return r.ok ? (r.data.commitments || []) : [];
};

// ── Search ──────────────────────────────────────────────
R.globalSearch = async function(apiFn, query) {
  var r = await apiFn('/raice/search?q=' + encodeURIComponent(query));
  return r.ok ? r.data : null;
};

})(window.RAICE = window.RAICE || {});
