/**
 * shared/utils/index.js
 * Funciones utilitarias puras del sistema RAICE.
 * NO debe contener lógica de negocio, llamadas a APIs ni dependencias de vistas específicas.
 */

/**
 * Escapa caracteres HTML para prevenir XSS al inyectar texto en el DOM.
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Devuelve una etiqueta legible de tiempo relativo en español.
 * Ejemplo: "hoy", "1 día", "5 días", "futuro".
 */
export function daysAgo(dateStr) {
  if (!dateStr) return '—';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (diff < 0) return 'futuro';
  if (diff === 0) return 'hoy';
  if (diff === 1) return '1 día';
  return diff + ' días';
}

/**
 * Muestra un toast de notificación flotante.
 * Requiere que exista un contenedor con id="t-wrap" en el DOM.
 */
export function toast(msg, type = 'info', ms = 3500) {
  const w = document.getElementById('t-wrap');
  if (!w) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/**
 * Inicia un reloj en la topbar que se actualiza cada 30 segundos.
 * Requiere un elemento con id="tb-clock" en el DOM.
 */
export function startClock() {
  function _tick() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const el = document.getElementById('tb-clock');
    if (el) el.textContent = hh + ':' + mm;
  }
  _tick();
  setInterval(_tick, 30000);
}

/**
 * Devuelve el color correspondiente según el porcentaje de asistencia.
 */
export function attendanceColor(pct) {
  if (pct === null || pct === undefined) return '#64748b';
  if (pct >= 90) return '#16a34a';
  if (pct >= 75) return '#ca8a04';
  return '#dc2626';
}

/**
 * Genera las iniciales (máx. 2 caracteres) a partir de un nombre completo.
 */
export function getInitials(name) {
  if (!name) return '??';
  return name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Formatea una fecha ISO a formato localizado colombiano.
 */
export function formatDateCO(dateStr, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('es-CO', options);
}

/**
 * Devuelve el saludo según la hora del día.
 */
export function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

/**
 * Retorna el día de la semana ISO (1=Lunes, 7=Domingo) a partir de Date.getDay().
 */
export function isoWeekday(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
}
