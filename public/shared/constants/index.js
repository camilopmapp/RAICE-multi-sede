/**
 * shared/constants/index.js
 * Constantes puras transversales del sistema RAICE.
 */
(function(R) {

R.CLASS_HOUR_ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª', '7ª', '8ª', '9ª', '10ª'];

R.DAYS_OF_WEEK = {1:'Lunes',2:'Martes',3:'Miércoles',4:'Jueves',5:'Viernes',6:'Sábado',7:'Domingo'};

R.DAYS_OF_WEEK_SHORT = {1:'Lun',2:'Mar',3:'Mie',4:'Jue',5:'Vie',6:'Sáb',7:'Dom'};

R.OBSERVATION_TYPE_LABELS = { positive:'Positiva', neutral:'Neutra', negative:'Negativa' };

R.OBSERVATION_TYPE_COLORS = { positive:'#16a34a', neutral:'#64748b', negative:'#dc2626' };

R.CASE_STATUS_LABELS = { open:'Abierto', tracking:'En seguimiento', closed:'Cerrado' };

R.CASE_TYPE_PILL_CLASS = { 1:'pill-t1', 2:'pill-t2', 3:'pill-t3' };

R.CASE_STATUS_PILL_CLASS = { open:'pill-open', tracking:'pill-open', closed:'pill-closed' };

R.CASE_TYPE_LABELS = { 1:'Tipo 1', 2:'Tipo 2', 3:'Tipo 3' };

R.ESCALON_LABELS = {
  llamado_verbal:'Llamado verbal',
  amonestacion_escrita:'Amonestación escrita',
  citacion_acudiente:'Citación acudiente',
  remision_coordinacion:'Remisión a coordinación'
};

R.ATTENDANCE_THRESHOLDS = { good:{min:90,color:'#16a34a'}, regular:{min:75,color:'#ca8a04'}, critical:{min:0,color:'#dc2626'} };

R.ATTENDANCE_STATUS_LABELS = { P:'Presente', A:'Ausente', T:'Tarde', PE:'Con permiso' };

R.ATTENDANCE_DONUT_COLORS = { present:'#0d9488', late:'#f59e0b', permit:'#a78bfa', absent:'#f43f5e' };

R.ALERT_SEVERITY_DOT_CLASS = { high:'d-red', medium:'d-orange', low:'d-blue' };

})(window.RAICE = window.RAICE || {});
