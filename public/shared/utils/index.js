/**
 * shared/utils/index.js
 * Funciones utilitarias puras del sistema RAICE.
 */
(function(R) {

R.escapeHtml = function(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

R.daysAgo = function(dateStr) {
  if (!dateStr) return '—';
  var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (diff < 0) return 'futuro';
  if (diff === 0) return 'hoy';
  if (diff === 1) return '1 día';
  return diff + ' días';
};

R.toast = function(msg, type, ms) {
  type = type || 'info';
  ms = ms || 3500;
  var w = document.getElementById('t-wrap');
  if (!w) return;
  var t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(function() { t.remove(); }, ms);
};

R.startClock = function() {
  function _tick() {
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var el = document.getElementById('tb-clock');
    if (el) el.textContent = hh + ':' + mm;
  }
  _tick();
  setInterval(_tick, 30000);
};

R.attendanceColor = function(pct) {
  if (pct === null || pct === undefined) return '#64748b';
  if (pct >= 90) return '#16a34a';
  if (pct >= 75) return '#ca8a04';
  return '#dc2626';
};

R.getInitials = function(name) {
  if (!name) return '??';
  return name.split(' ').map(function(w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
};

R.formatDateCO = function(dateStr, options) {
  if (!dateStr) return '—';
  options = options || { day:'numeric', month:'short', year:'numeric' };
  return new Date(dateStr).toLocaleDateString('es-CO', options);
};

R.getGreeting = function() {
  var h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
};

R.isoWeekday = function(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
};

/**
 * Color de avatar determinístico basado en el primer carácter del nombre.
 */
R.avatarColor = function(name) {
  var c = ['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#0b7a75','#ec4899'];
  return c[(name || 'A').charCodeAt(0) % c.length];
};

/**
 * Formato de fecha corto para admin/superadmin: "06 jun 2026".
 */
R.formatDate = function(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { day:'2-digit', month:'short', year:'numeric' });
};

/**
 * Deriva los datos de perfil de un usuario para mostrar en la UI.
 * @param {Object} user — { first_name, last_name, username }
 * @param {string} fallbackRole — texto por defecto si no hay nombre ('Coordinador', 'Superadmin', etc.)
 * @returns {{ initials: string, fullName: string, displayUsername: string }}
 */
R.deriveProfileData = function(user, fallbackRole) {
  fallbackRole = fallbackRole || 'Usuario';
  if (!user) return { initials: '??', fullName: fallbackRole, displayUsername: '@' + fallbackRole.toLowerCase() };
  var first = user.first_name || fallbackRole[0] || 'U';
  var last  = user.last_name  || fallbackRole[1] || 'S';
  return {
    initials: (first[0] + last[0]).toUpperCase(),
    fullName: ((user.first_name || '') + ' ' + (user.last_name || '')).trim() || fallbackRole,
    displayUsername: '@' + (user.username || fallbackRole.toLowerCase())
  };
};

/**
 * Aplica el logo del colegio en el sidebar (usado por docente y superadmin).
 */
R.applyLogoToSidebar = function(logoUrl, schoolName) {
  var logoImg = document.getElementById('sb-logo-img');
  var markFb  = document.getElementById('sb-mark-fallback');
  var nameEl  = document.querySelector('.sb-name');
  if (logoUrl) {
    if (logoImg) { logoImg.src = logoUrl; logoImg.style.display = 'block'; }
    if (markFb) markFb.style.display = 'flex';
  } else {
    if (logoImg) logoImg.style.display = 'none';
    if (markFb) markFb.style.display = 'flex';
  }
  if (schoolName && nameEl) nameEl.title = schoolName;
};

/**
 * Toast con iconos para admin/docente/superadmin (container: toast-container).
 */
R.showToast = function(msg, type) {
  type = type || 'success';
  var c = document.getElementById('toast-container');
  if (!c) return;
  var t = document.createElement('div');
  t.className = 'toast ' + type;
  var ico = {success:'✅',error:'❌',warning:'⚠️'}[type] || 'ℹ️';
  t.innerHTML = '<span>' + ico + '</span><span>' + msg + '</span>';
  c.appendChild(t);
  setTimeout(function() { t.remove(); }, 3800);
};

/**
 * Cierra sesión: limpia storage y redirige al login.
 */
R.logout = function() {
  if (!confirm('¿Cerrar sesión?')) return;
  sessionStorage.clear();
  localStorage.removeItem('raice_token');
  localStorage.removeItem('raice_role');
  localStorage.removeItem('raice_user');
  window.location.href = '/login.html';
};

})(window.RAICE = window.RAICE || {});
