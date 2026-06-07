/**
 * shared/utils/printObservador.js
 * Genera e imprime la ventana del Observador del Estudiante.
 * Usado por rector, admin y docente.
 */
(function(R) {

R.printObservadorWindow = function(d, cfg) {
  var RAICE = window.RAICE;
  var typeLabel = RAICE.OBSERVATION_TYPE_LABELS;
  var typeColor = RAICE.OBSERVATION_TYPE_COLORS;
  var statusLbl = RAICE.CASE_STATUS_LABELS;

  var s = d.student, at = d.attendance || {}, obs = d.observations || [], cases = d.cases || [];
  var schoolName = cfg.school_name || 'Institución Educativa';
  var schoolLoc  = cfg.location || '';
  var schoolLogo = cfg.logo_url
    ? '<img src="' + cfg.logo_url + '" style="height:55px;object-fit:contain;" alt="logo">'
    : '<div style="font-size:2.2rem;">🏫</div>';
  var raiceLogo = '<img src="' + window.location.origin + '/favicon.png" style="height:40px;object-fit:contain;" alt="RAICE" onerror="this.style.display=\'none\'">';
  var now = new Date().toLocaleDateString('es-CO', { day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' });
  var curso = s.grade ? s.grade + '°' + (s.number || '') : (s.course || '—');

  var obsRows = obs.map(function(o) {
    var fecha = new Date(o.created_at).toLocaleDateString('es-CO', { day:'numeric', month:'short', year:'numeric' });
    var tl = typeLabel[o.type] || o.type;
    var tc = typeColor[o.type] || '#333';
    return '<tr>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + fecha + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;font-weight:600;color:' + tc + ';">' + tl + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + (o.text || '') + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + (o.teacher_name || '—') + '</td>'
      + '</tr>';
  }).join('');

  var casesRows = cases.map(function(c) {
    var fecha = new Date(c.created_at).toLocaleDateString('es-CO', { day:'numeric', month:'short', year:'numeric' });
    var st = statusLbl[c.status] || c.status;
    return '<tr>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + fecha + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;text-align:center;">Tipo ' + c.type + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + ((c.description || '').substring(0, 120)) + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;text-align:center;">' + st + '</td>'
      + '<td style="border:1px solid #ccc;padding:4px 8px;font-size:9pt;">' + (c.teacher_name || '—') + '</td>'
      + '</tr>';
  }).join('');

  var attPctColor = (at.pct !== null && at.pct < 80) ? '#dc2626' : '#16a34a';
  var attPctVal   = at.pct != null ? at.pct + '%' : '—%';

  var html = '<!DOCTYPE html><html><head><title>Observador — ' + s.first_name + ' ' + s.last_name + '</title>'
    + '<style>'
    + '@page{size:A4;margin:15mm}'
    + 'body{font-family:Arial,sans-serif;font-size:10pt;color:#1e293b;line-height:1.5;}'
    + 'table{width:100%;border-collapse:collapse;}'
    + 'th{background:#f1f5f9;border:1px solid #ccc;padding:5px 8px;font-size:8.5pt;text-transform:uppercase;letter-spacing:.03em;text-align:left;}'
    + 'tr:nth-child(even){background:#fafbfc;}'
    + '.header{display:flex;align-items:center;justify-content:space-between;border-bottom:2.5px solid #1e293b;padding-bottom:.8rem;margin-bottom:1.2rem;}'
    + '.header-center{text-align:center;flex:1;}'
    + '.header-center h1{margin:0;font-size:13pt;font-weight:800;}'
    + '.header-center .loc{font-size:8.5pt;color:#555;margin-top:2px;}'
    + '.section-title{font-size:11pt;font-weight:800;color:#1e293b;margin:1.2rem 0 .5rem;padding-bottom:.3rem;border-bottom:1.5px solid #e2e8f0;}'
    + '.student-info{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem .8rem;margin-bottom:1rem;background:#f8fafc;padding:.7rem 1rem;border-radius:6px;border:1px solid #e2e8f0;}'
    + '.si-label{font-size:8pt;color:#64748b;text-transform:uppercase;letter-spacing:.04em;}'
    + '.si-value{font-size:10pt;font-weight:700;color:#1e293b;}'
    + '.att-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem;margin-bottom:1rem;}'
    + '.att-box{text-align:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:.5rem .3rem;}'
    + '.att-val{font-size:14pt;font-weight:800;}'
    + '.att-lbl{font-size:7.5pt;color:#64748b;text-transform:uppercase;}'
    + '.footer{text-align:center;margin-top:2rem;font-size:8pt;color:#999;border-top:1px solid #e2e8f0;padding-top:.5rem;}'
    + '</style></head><body>'
    + '<div class="header">'
    +   schoolLogo
    +   '<div class="header-center">'
    +     '<h1>' + schoolName + '</h1>'
    +     (schoolLoc ? '<div class="loc">' + schoolLoc + '</div>' : '')
    +     '<div style="font-size:10pt;font-weight:600;margin-top:6px;color:#0b7a75;">OBSERVADOR DEL ESTUDIANTE</div>'
    +   '</div>'
    +   raiceLogo
    + '</div>'
    + '<div class="student-info">'
    +   '<div><div class="si-label">Nombre completo</div><div class="si-value">' + s.first_name + ' ' + s.last_name + '</div></div>'
    +   '<div><div class="si-label">Curso</div><div class="si-value">' + curso + '</div></div>'
    +   '<div><div class="si-label">Estado</div><div class="si-value">' + (s.status === 'inactive' ? 'Retirado' : 'Activo') + '</div></div>'
    + '</div>'
    + '<div class="section-title">Resumen de asistencia</div>'
    + '<div class="att-grid">'
    +   '<div class="att-box"><div class="att-val" style="color:' + attPctColor + ';">' + attPctVal + '</div><div class="att-lbl">Asistencia</div></div>'
    +   '<div class="att-box"><div class="att-val" style="color:#16a34a;">' + (at.present || 0) + '</div><div class="att-lbl">Presencias</div></div>'
    +   '<div class="att-box"><div class="att-val" style="color:#dc2626;">' + (at.absent || 0) + '</div><div class="att-lbl">Ausencias</div></div>'
    +   '<div class="att-box"><div class="att-val" style="color:#f59e0b;">' + (at.late || 0) + '</div><div class="att-lbl">Tardanzas</div></div>'
    +   '<div class="att-box"><div class="att-val" style="color:#7c3aed;">' + (at.permit || 0) + '</div><div class="att-lbl">Permisos</div></div>'
    + '</div>'
    + '<div style="font-size:7.5pt;color:#94a3b8;text-align:center;margin-top:-.5rem;margin-bottom:.8rem;">* Estadísticas en horas de clase</div>'
    + '<div class="section-title">Observaciones (' + obs.length + ')</div>'
    + (obs.length
        ? '<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Observación</th><th>Docente</th></tr></thead><tbody>' + obsRows + '</tbody></table>'
        : '<div style="text-align:center;padding:1rem;color:#94a3b8;font-size:9pt;">Sin observaciones registradas</div>')
    + '<div class="section-title">Casos RAICE (' + cases.length + ')</div>'
    + (cases.length
        ? '<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Estado</th><th>Reportado por</th></tr></thead><tbody>' + casesRows + '</tbody></table>'
        : '<div style="text-align:center;padding:1rem;color:#94a3b8;font-size:9pt;">Sin casos RAICE registrados</div>')
    + '<div class="footer">Generado el ' + now + ' — Sistema RAICE</div>'
    + '</body></html>';

  var w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  setTimeout(function() { w.print(); }, 500);
};

})(window.RAICE = window.RAICE || {});
