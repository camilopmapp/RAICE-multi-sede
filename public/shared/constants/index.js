/**
 * shared/constants/index.js
 * Constantes puras transversales del sistema RAICE.
 * NO debe contener lógica de negocio, llamadas a APIs ni dependencias del DOM.
 */

// ── Ordinales de hora de clase ──────────────────────────
export const CLASS_HOUR_ORDINALS = [
  '', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª', '7ª', '8ª', '9ª', '10ª'
];

// ── Días de la semana (indexados por day_of_week ISO: 1=Lunes … 7=Domingo) ──
export const DAYS_OF_WEEK = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo'
};

export const DAYS_OF_WEEK_SHORT = {
  1: 'Lun',
  2: 'Mar',
  3: 'Mie',
  4: 'Jue',
  5: 'Vie',
  6: 'Sáb',
  7: 'Dom'
};

// ── Etiquetas y colores de tipos de observación ─────────
export const OBSERVATION_TYPE_LABELS = {
  positive: 'Positiva',
  neutral: 'Neutra',
  negative: 'Negativa'
};

export const OBSERVATION_TYPE_COLORS = {
  positive: '#16a34a',
  neutral: '#64748b',
  negative: '#dc2626'
};

// ── Etiquetas de estado de casos RAICE ──────────────────
export const CASE_STATUS_LABELS = {
  open: 'Abierto',
  tracking: 'En seguimiento',
  closed: 'Cerrado'
};

// ── Mapeo CSS de pills por tipo de falta (1, 2, 3) ─────
export const CASE_TYPE_PILL_CLASS = {
  1: 'pill-t1',
  2: 'pill-t2',
  3: 'pill-t3'
};

// ── Mapeo CSS de pills por estado de caso ───────────────
export const CASE_STATUS_PILL_CLASS = {
  open: 'pill-open',
  tracking: 'pill-open',
  closed: 'pill-closed'
};

// ── Etiquetas de tipo de caso RAICE ─────────────────────
export const CASE_TYPE_LABELS = {
  1: 'Tipo 1',
  2: 'Tipo 2',
  3: 'Tipo 3'
};

// ── Etiquetas de escalones (Tipo 1) ─────────────────────
export const ESCALON_LABELS = {
  llamado_verbal: 'Llamado verbal',
  amonestacion_escrita: 'Amonestación escrita',
  citacion_acudiente: 'Citación acudiente',
  remision_coordinacion: 'Remisión a coordinación'
};

// ── Colores por umbral de asistencia ────────────────────
export const ATTENDANCE_THRESHOLDS = {
  good:     { min: 90, color: '#16a34a' },
  regular:  { min: 75, color: '#ca8a04' },
  critical: { min: 0,  color: '#dc2626' }
};

// ── Mapeo de estados de asistencia ──────────────────────
export const ATTENDANCE_STATUS_LABELS = {
  P:  'Presente',
  A:  'Ausente',
  T:  'Tarde',
  PE: 'Con permiso'
};

// ── Colores del donut de asistencia ─────────────────────
export const ATTENDANCE_DONUT_COLORS = {
  present: '#0d9488',
  late:    '#f59e0b',
  permit:  '#a78bfa',
  absent:  '#f43f5e'
};

// ── Severidad de alertas → clase CSS del dot ────────────
export const ALERT_SEVERITY_DOT_CLASS = {
  high:   'd-red',
  medium: 'd-orange',
  low:    'd-blue'
};
