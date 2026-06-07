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

R.fetchStudentFicha = async function(apiFn, studentId, allObs) {
  var path = '/raice/student-ficha?id=' + studentId;
  if (allObs) path += '&all_obs=1';
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
  if (!r.ok) return { schedules: [], bell_schedule: [] };
  return {
    schedules: r.data.schedules || [],
    bell_schedule: r.data.bell_schedule || []
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

})(window.RAICE = window.RAICE || {});
