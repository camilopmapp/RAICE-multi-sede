/**
 * shared/domain/index.js
 * Reglas de negocio puras del sistema RAICE.
 * Funciones sin efectos secundarios, sin dependencias de UI ni de infraestructura.
 */

/**
 * Formatea un número de grado escolar: 0/null → 'Transición', 1-11 → '1°'…'11°'.
 */
export function gradeLbl(g) {
  return (g === 0 || g === '0' || g === null) && g !== undefined
    ? 'Transición'
    : (g + '°');
}

/**
 * Encuentra la hora de clase activa según el horario de timbres.
 * @param {Array<{class_hour:number, start_time:string, end_time:string}>} bellSchedule
 * @returns {Object|null} El registro de timbre activo, o null si no hay clase.
 */
export function getCurrentBell(bellSchedule) {
  if (!bellSchedule?.length) return null;
  const now = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
  return bellSchedule.find(b =>
    b.start_time && b.end_time &&
    now >= b.start_time.slice(0, 5) &&
    now <= b.end_time.slice(0, 5)
  ) || null;
}

/**
 * Obtiene la hora actual en Colombia como string HH:MM.
 */
export function nowColombia() {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}

/**
 * Retorna la fecha de hoy en Colombia como string YYYY-MM-DD.
 */
export function todayColombia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

/**
 * Calcula el porcentaje de asistencia excluyendo permisos del denominador.
 * Fórmula: (presentes + tarde) / (presentes + ausentes + tarde) × 100
 */
export function calcAttendancePct(present, absent, late) {
  const countable = present + absent + late;
  if (countable <= 0) return null;
  return Math.round(((present + late) / countable) * 100);
}

/**
 * Clasifica un nivel de riesgo según el puntaje.
 * @returns {{ level: string, color: string, bg: string, borderColor: string }}
 */
export function classifyRisk(score) {
  if (score >= 60) return { level: 'Alto', color: '#dc2626', bg: '#fee2e2', borderColor: '#fca5a5' };
  if (score >= 30) return { level: 'Medio', color: '#c2410c', bg: '#fff7ed', borderColor: '#fed7aa' };
  return { level: 'Bajo', color: '#a16207', bg: '#fef9c3', borderColor: '#fde68a' };
}

/**
 * Determina si hoy es fin de semana en Colombia.
 */
export function isWeekend() {
  const jsDay = new Date().getDay();
  return jsDay === 0 || jsDay === 6;
}
