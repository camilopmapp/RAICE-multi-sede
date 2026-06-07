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

})(window.RAICE = window.RAICE || {});
