/**
 * shared/domain/index.js
 * Reglas de negocio puras del sistema RAICE.
 */
(function(R) {

R.gradeLbl = function(g) {
  return (g === 0 || g === '0' || g === null) && g !== undefined ? 'Transición' : (g + '°');
};

R.getCurrentBell = function(bellSchedule) {
  if (!bellSchedule || !bellSchedule.length) return null;
  var now = new Intl.DateTimeFormat('es-CO', {
    timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', hour12:false
  }).format(new Date());
  return bellSchedule.find(function(b) {
    return b.start_time && b.end_time &&
      now >= b.start_time.slice(0, 5) &&
      now <= b.end_time.slice(0, 5);
  }) || null;
};

R.nowColombia = function() {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', hour12:false
  }).format(new Date());
};

R.todayColombia = function() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'America/Bogota' }).format(new Date());
};

R.calcAttendancePct = function(present, absent, late) {
  var countable = present + absent + late;
  if (countable <= 0) return null;
  return Math.round(((present + late) / countable) * 100);
};

R.classifyRisk = function(score) {
  if (score >= 60) return { level:'Alto', color:'#dc2626', bg:'#fee2e2', borderColor:'#fca5a5' };
  if (score >= 30) return { level:'Medio', color:'#c2410c', bg:'#fff7ed', borderColor:'#fed7aa' };
  return { level:'Bajo', color:'#a16207', bg:'#fef9c3', borderColor:'#fde68a' };
};

R.isWeekend = function() {
  var jsDay = new Date().getDay();
  return jsDay === 0 || jsDay === 6;
};

})(window.RAICE = window.RAICE || {});
