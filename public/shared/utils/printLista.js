/**
 * shared/utils/printLista.js
 * Genera e imprime la lista de estudiantes de un curso.
 * Usado por docente desde "Mis estudiantes".
 */
(function(R) {

  function workingDays(startDateStr, count) {
    var parts = startDateStr.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1, parts[2], 12);
    var result = [];
    while (result.length < count) {
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        result.push(d.getDate() + '/' + (d.getMonth() + 1));
      }
      d.setDate(d.getDate() + 1);
    }
    return result;
  }

  R.printLista = function(students, course, teacherName, cfg, opts) {
    opts = opts || {};
    var sortBy      = opts.sortBy      || 'lastname';
    var colCount    = Math.min(20, Math.max(1, parseInt(opts.colCount) || 5));
    var colType     = opts.colType     || 'number';
    var showDoc     = !!opts.showDoc;
    var showSig     = opts.showSig !== false;
    var showObs     = !!opts.showObs;
    var orientation = opts.orientation || 'landscape';
    var paper       = opts.paper       || 'letter';

    // Sort
    var sorted = students.slice().sort(function(a, b) {
      var ka = sortBy === 'lastname'
        ? (a.last_name || '') + (a.first_name || '')
        : (a.first_name || '') + (a.last_name || '');
      var kb = sortBy === 'lastname'
        ? (b.last_name || '') + (b.first_name || '')
        : (b.first_name || '') + (b.last_name || '');
      return ka.toLowerCase() < kb.toLowerCase() ? -1 : ka.toLowerCase() > kb.toLowerCase() ? 1 : 0;
    });

    // Column labels
    var labels = [];
    if (colType === 'date' && opts.colStartDate) {
      labels = workingDays(opts.colStartDate, colCount);
    } else if (colType === 'custom' && opts.colLabels && opts.colLabels.length) {
      labels = opts.colLabels.slice(0, colCount);
      while (labels.length < colCount) labels.push('');
    } else {
      for (var i = 1; i <= colCount; i++) labels.push(String(i));
    }

    // Font size based on student count
    var n  = sorted.length;
    var fs = n <= 25 ? 9 : n <= 35 ? 8 : n <= 45 ? 7 : 6.5;

    // Logos and metadata
    var schoolName = cfg.school_name || 'Institución Educativa';
    var schoolLoc  = cfg.location    || '';
    var year       = cfg.year        || new Date().getFullYear();
    var schoolLogo = cfg.logo_url
      ? '<img src="' + cfg.logo_url + '" style="height:52px;object-fit:contain;" alt="logo">'
      : '<div style="font-size:1.8rem;line-height:1;">🏫</div>';
    var raiceLogo  = '<img src="' + window.location.origin + '/favicon.png"'
      + ' style="height:38px;object-fit:contain;" alt="RAICE"'
      + ' onerror="this.style.display=\'none\'">';

    var courseLabel = course.type === 'subgroup'
      ? (course.name || 'Subgrupo')
      : ((course.grade || '') + '°' + (course.number || ''));
    var subject = course.subject || '';
    var now = new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

    // ── Anchos de columna en píxeles ─────────────────────────────────────────
    // Todas las columnas fijas tienen px explícito.
    // La columna de NOMBRES no tiene ancho → con table-layout:fixed absorbe
    // exactamente el espacio sobrante, sin hueco ni desbordamiento.
    var numW = 28;
    var docW = showDoc ? 90 : 0;
    var obsW = showObs ? 80 : 0;
    var sigW = showSig ? 55 : 0;

    // Presupuesto fijo de ~320px para las columnas de registro (igual que admin).
    // Con 1 columna: 320px cada una. Con 20: mínimo 22px.
    var colW = Math.max(22, Math.floor(320 / colCount));

    // Seguridad: si el total supera el ancho de página disponible,
    // reducir colW para que el nombre siempre tenga al menos 150px.
    var pageW = orientation === 'portrait'
      ? (paper === 'a4' ? 734 : 720)
      : (paper === 'a4' ? 1064 : 996);
    var fixedW  = numW + docW + obsW + sigW + (colW * colCount);
    var minNameW = 150;
    if (pageW - fixedW < minNameW) {
      colW = Math.max(18, Math.floor((pageW - numW - docW - obsW - sigW - minNameW) / colCount));
    }

    // ── Altura de fila calculada en JS para llenar exactamente la hoja ───────
    var pageH = orientation === 'portrait'
      ? (paper === 'a4' ? 980 : 920)
      : (paper === 'a4' ? 680 : 590);
    var hdrH    = 75;
    var theadH  = 22;
    var footerH = 115;
    var availH  = pageH - hdrH - theadH - footerH;
    var rowH    = Math.max(14, Math.floor(availH / Math.max(sorted.length, 1)));

    // Encabezados de columnas de registro
    var thCols = labels.map(function(lbl) {
      return '<th style="width:' + colW + 'px;text-align:center;white-space:nowrap;'
        + 'overflow:hidden;text-overflow:ellipsis;font-size:' + (fs - 0.5) + 'pt;">' + lbl + '</th>';
    }).join('');

    // Filas de datos
    var tbRows = sorted.map(function(s, idx) {
      var nameStr = sortBy === 'lastname'
        ? (s.last_name || '') + ', ' + (s.first_name || '')
        : (s.first_name || '') + ' ' + (s.last_name || '');
      var docStr = (s.doc_type ? s.doc_type + ' ' : '') + (s.doc_number || '—');
      return '<tr style="height:' + rowH + 'px;">'
        + '<td style="border:1px solid #cbd5e1;padding:2px 3px;text-align:center;vertical-align:middle;">' + (idx + 1) + '</td>'
        + '<td style="border:1px solid #cbd5e1;padding:2px 6px;vertical-align:middle;">' + nameStr + '</td>'
        + (showDoc ? '<td style="border:1px solid #cbd5e1;padding:2px 4px;font-size:' + (fs - 0.5) + 'pt;vertical-align:middle;">' + docStr + '</td>' : '')
        + labels.map(function() { return '<td style="border:1px solid #cbd5e1;"></td>'; }).join('')
        + (showObs ? '<td style="border:1px solid #cbd5e1;"></td>' : '')
        + (showSig ? '<td style="border:1px solid #cbd5e1;"></td>' : '')
        + '</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<title>Lista ' + courseLabel + (subject ? ' · ' + subject : '') + '</title>'
      + '<style>'
      + '@page{size:' + paper + ' ' + orientation + ';margin:8mm}'
      + '*{box-sizing:border-box;margin:0;padding:0}'
      + 'body{font-family:Arial,Helvetica,sans-serif;font-size:' + fs + 'pt;color:#1e293b;}'
      + '.hdr{display:flex;align-items:center;gap:6px;border-bottom:2.5px solid #1e293b;'
      + 'padding-bottom:5px;margin-bottom:7px;}'
      + '.hdr-center{flex:1;text-align:center;padding:0 8px;}'
      + '.hdr-center h1{font-size:' + (fs + 4) + 'pt;font-weight:900;margin-bottom:1px;}'
      + '.hdr-center .loc{font-size:' + (fs - 1) + 'pt;color:#64748b;}'
      + '.hdr-center .ttl{font-size:' + (fs + 1) + 'pt;font-weight:700;color:#0b7a75;margin-top:2px;}'
      + '.meta{display:flex;flex-wrap:wrap;gap:4px 14px;background:#f8fafc;border:1px solid #e2e8f0;'
      + 'border-radius:4px;padding:3px 8px;margin-bottom:6px;font-size:' + (fs - 0.5) + 'pt;color:#475569;}'
      /* table-layout:fixed + columna de nombre sin ancho = nombre ocupa exactamente el espacio sobrante */
      + 'table{width:100%;border-collapse:collapse;table-layout:fixed;}'
      + 'th{background:#1e293b;color:#fff;border:1px solid #1e293b;padding:3px 4px;'
      + 'font-size:' + (fs - 0.5) + 'pt;text-align:left;}'
      + 'tr:nth-child(even) td{background:#f8fafc;}'
      + '.foot{margin-top:10px;display:flex;justify-content:space-between;align-items:flex-end;'
      + 'font-size:' + (fs - 1) + 'pt;color:#475569;}'
      + '.sig-block{text-align:center;min-width:130px;}'
      + '.sig-space{height:22mm;border-bottom:1px solid #1e293b;width:100%;display:block;margin-bottom:4px;}'
      + '.sig-label{font-size:' + (fs - 1) + 'pt;color:#475569;}'
      + '</style></head><body>'
      + '<div class="hdr">' + schoolLogo
      + '<div class="hdr-center">'
      + '<h1>' + schoolName + '</h1>'
      + (schoolLoc ? '<div class="loc">' + schoolLoc + '</div>' : '')
      + '<div class="ttl">LISTA DE ESTUDIANTES</div>'
      + '</div>' + raiceLogo + '</div>'
      + '<div class="meta">'
      + '<span><b>Curso:</b> ' + courseLabel + '</span>'
      + (subject ? '<span><b>Asignatura:</b> ' + subject + '</span>' : '')
      + '<span><b>Docente:</b> ' + teacherName + '</span>'
      + '<span><b>Año:</b> ' + year + '</span>'
      + '<span><b>Impreso:</b> ' + now + '</span>'
      + '</div>'
      + '<table><thead><tr>'
      + '<th style="width:' + numW + 'px;">#</th>'
      /* sin width → absorbe todo el espacio libre */
      + '<th>' + (sortBy === 'lastname' ? 'Apellidos, Nombres' : 'Nombres y Apellidos') + '</th>'
      + (showDoc ? '<th style="width:' + docW + 'px;">Documento</th>' : '')
      + thCols
      + (showObs ? '<th style="width:' + obsW + 'px;">Observaciones</th>' : '')
      + (showSig ? '<th style="width:' + sigW + 'px;">VB</th>' : '')
      + '</tr></thead><tbody>' + tbRows + '</tbody></table>'
      + '<div class="foot">'
      + '<span>Total: <b>' + sorted.length + '</b> estudiantes</span>'
      + '<div style="display:flex;gap:30px;">'
      + '<div class="sig-block"><span class="sig-space"></span><span class="sig-label">Firma del docente</span></div>'
      + '<div class="sig-block"><span class="sig-space"></span><span class="sig-label">Director de grado</span></div>'
      + '</div></div>'
      + '</body></html>';

    var w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    setTimeout(function() { w.print(); }, 500);
  };

})(window.RAICE = window.RAICE || {});
