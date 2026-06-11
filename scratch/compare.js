const fs = require('fs');

const userSnippet = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="/manifest.json">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="RAICE">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="icon" href="/favicon.png">
  <meta name="theme-color" content="#0f1f3d">
<title>RAICE — Docente</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700;9..144,900&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --navy:#0f1f3d; --teal:#0b7a75; --teal2:#14b8b0;
    --gold:#e8a020; --rose:#c0392b; --cream:#f4f1eb;
    --white:#fff; --gray:#64748b; --light:#f8fafc;
    --border:#e2e8f0; --shadow:0 2px 12px rgba(15,31,61,.09);
    --present:#10b981; --absent:#ef4444; --permit:#f59e0b;
    --sidebar:230px;
  }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  html, body { height:100%; }
  body { font-family:'DM Sans',sans-serif; background:var(--cream); color:var(--navy); display:flex; }

  /* === SIDEBAR === */
  .sidebar {
    width:var(--sidebar);
    background:var(--navy);
    display:flex; flex-direction:column;
    position:fixed; top:0; left:0; bottom:0; z-index:100;
  }
  .sidebar-brand {
    padding:1.4rem 1.2rem 1.1rem;
    border-bottom:1px solid rgba(255,255,255,.08);
    display:flex; align-items:center; gap:.7rem;
  }
  .sb-mark {
    width:36px; height:36px; background:var(--teal2);
    border-radius:9px; display:flex; align-items:center; justify-content:center;
    font-family:'Fraunces',serif; font-weight:900; font-size:.95rem;
    color:var(--navy); flex-shrink:0;
  }
  .sb-logo {
    width:36px; height:36px; object-fit:contain;
    border-radius:9px; background:var(--white);
    flex-shrink:0; display:none;
  }
  .sb-name { font-family:'Fraunces',serif; font-weight:900; color:var(--white); font-size:1rem; }
  .sb-role { font-size:.68rem; color:rgba(255,255,255,.4); text-transform:uppercase; letter-spacing:.06em; }
  .sidebar-nav { flex:1; padding:.85rem .7rem; display:flex; flex-direction:column; gap:.1rem; }
  .nav-group-title {
    font-size:.65rem; font-weight:700; letter-spacing:.1em;
    text-transform:uppercase; color:rgba(255,255,255,.3);
    padding:.65rem .5rem .35rem;
  }
  .nav-item {
    display:flex; align-items:center; gap:.65rem;
    padding:.6rem .7rem; border-radius:9px;
    cursor:pointer; transition:background .15s;
    font-size:.855rem; color:rgba(255,255,255,.6);
    text-decoration:none; border:none; background:none;
    width:100%; text-align:left; font-family:'DM Sans',sans-serif;
  }
  .nav-item:hover { background:rgba(255,255,255,.07); color:rgba(255,255,255,.9); }
  .nav-item.active { background:rgba(20,184,176,.18); color:var(--teal2); font-weight:600; }
  .nav-item .nav-ico { font-size:.95rem; width:18px; text-align:center; flex-shrink:0; }
  .sidebar-footer { padding:.9rem .7rem; border-top:1px solid rgba(255,255,255,.08); }
  .user-chip {
    display:flex; align-items:center; gap:.6rem;
    padding:.55rem .7rem; background:rgba(255,255,255,.06); border-radius:9px; margin-bottom:.45rem;
  }
  .user-avatar {
    width:30px; height:30px; border-radius:50%;
    background:var(--teal2); display:flex; align-items:center;
    justify-content:center; font-weight:700; font-size:.75rem;
    color:var(--navy); flex-shrink:0;
  }
  .user-name { font-size:.8rem; font-weight:600; color:var(--white); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .user-role-badge { font-size:.68rem; color:var(--teal2); }
  .btn-logout {
    width:100%; padding:.5rem; border:none; border-radius:7px;
    background:rgba(220,38,38,.15); color:#fca5a5;
    font-family:'DM Sans',sans-serif; font-size:.8rem; font-weight:600;
    cursor:pointer; transition:background .2s;
  }
  .btn-logout:hover { background:rgba(220,38,38,.3); }

  /* === MAIN === */
  .main { margin-left:var(--sidebar); flex:1; display:flex; flex-direction:column; min-height:100vh; }
  .topbar {
    background:var(--white); border-bottom:1px solid var(--border);
    padding:.8rem 1.75rem; display:flex; align-items:center;
    justify-content:space-between; position:sticky; top:0; z-index:50;
  }
  .page-title { font-family:'Fraunces',serif; font-size:1.15rem; font-weight:700; color:var(--navy); }
  .topbar-right { display:flex; align-items:center; gap:.75rem; }
  .topbar-badge {
    background:rgba(20,184,176,.12); color:var(--teal);
    border:1px solid rgba(20,184,176,.3); border-radius:999px;
    padding:.22rem .75rem; font-size:.72rem; font-weight:700;
    letter-spacing:.04em; text-transform:uppercase;
  }
  .content { padding:1.75rem; flex:1; }
  .section { display:none; }
  .section.active { display:block; animation:fadeIn .2s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }

  /* === CARDS === */
  .card {
    background:var(--white); border-radius:16px;
    box-shadow:var(--shadow); margin-bottom:1.25rem;
  }
  .card-header {
    padding:1.1rem 1.4rem .85rem;
    border-bottom:1px solid var(--border);
    display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.6rem;
  }
  .card-header h3 { font-family:'Fraunces',serif; font-size:1rem; font-weight:700; color:var(--navy); }
  .card-body { padding:1.4rem; }

  /* === COURSE CARDS === */
  .courses-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:1rem; }
  .course-card {
    background:var(--white); border:2px solid var(--border); border-radius:16px;
    padding:1.1rem 1.25rem; cursor:pointer; transition:all .2s;
    display:flex; align-items:center; gap:1.1rem;
  }
  .course-card:hover { border-color:var(--teal2); transform:translateY(-1px); box-shadow:0 6px 20px rgba(11,122,117,.13); }
  .course-card.done  { opacity:.6; }
  .course-card.active-now { border-color:var(--teal2); box-shadow:0 0 0 3px rgba(20,184,176,.15); }

  /* Time column */
  .cc-time {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    min-width:52px; gap:.15rem;
  }
  .cc-hour  { font-family:'Fraunces',serif; font-size:1.5rem; font-weight:900; color:var(--navy); line-height:1; }
  .cc-htime { font-size:.68rem; color:var(--gray); white-space:nowrap; }

  /* Vertical divider */
  .cc-divider { width:2px; align-self:stretch; border-radius:2px; background:var(--border); flex-shrink:0; }
  .course-card.active-now .cc-divider { background:var(--teal2); }

  /* Info column */
  .cc-info { flex:1; min-width:0; }
  .cc-grade { font-family:'Fraunces',serif; font-size:1.2rem; font-weight:900; color:var(--navy); line-height:1; }
  .cc-subject { font-size:.82rem; color:var(--gray); margin-top:.1rem; }
  .cc-stats { display:flex; gap:.4rem; flex-wrap:wrap; margin-top:.5rem; }
  .cc-stat { font-size:.73rem; background:var(--light); border-radius:6px; padding:.18rem .45rem; color:var(--navy); font-weight:600; }

  /* Status badge */
  .cc-status { flex-shrink:0; display:flex; flex-direction:column; align-items:flex-end; gap:.3rem; }
  .cc-pill {
    font-size:.72rem; font-weight:700; border-radius:20px; padding:.22rem .65rem;
    white-space:nowrap;
  }
  .cc-pill.pending { background:#fff7ed; color:#c2410c; }
  .cc-pill.done    { background:#dcfce7; color:#16a34a; }
  .cc-pill.now     { background:rgba(20,184,176,.15); color:var(--teal); }

  /* Empty-day banner */
  .no-classes-today {
    grid-column:1/-1; text-align:center; padding:3rem 1rem;
  }

  /* Courses grid becomes a vertical list */
  .courses-grid {
    display:flex; flex-direction:column; gap:.75rem;
  }
  .courses-grid .grid-section-title {
    font-size:.75rem; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
    color:var(--gray); padding:.25rem 0; margin-top:.5rem;
  }

  .course-name { font-size:.82rem; color:var(--gray); margin-bottom:.65rem; }
  .course-stats { display:flex; gap:.5rem; flex-wrap:wrap; }
  .course-stat { font-size:.75rem; background:var(--light); border-radius:6px; padding:.2rem .5rem; color:var(--navy); font-weight:600; }

  /* === ATTENDANCE LIST === */
  .att-header {
    display:flex; align-items:center; justify-content:space-between;
    margin-bottom:1.1rem; flex-wrap:wrap; gap:.75rem;
  }
  .att-title { font-family:'Fraunces',serif; font-size:1.25rem; font-weight:700; color:var(--navy); }
  .att-date-info { font-size:.85rem; color:var(--gray); }
  .att-stats {
    display:grid; grid-template-columns:repeat(4,1fr); gap:.65rem;
    margin-bottom:1.25rem;
  }
  .att-stat {
    border-radius:12px; padding:.85rem .75rem; text-align:center;
    font-weight:700; font-size:1.4rem; font-family:'Fraunces',serif;
  }
  .att-stat.p { background:#ecfdf5; color:var(--present); }
  .att-stat.a { background:#fef2f2; color:var(--absent); }
  .att-stat.pe { background:#fffbeb; color:var(--permit); }
  .att-stat-label { font-family:'DM Sans',sans-serif; font-size:.75rem; font-weight:500; margin-top:.2rem; }

  /* === STUDENT ROW === */
  .student-list { display:flex; flex-direction:column; gap:.45rem; }
  .student-row {
    display:flex; align-items:center; gap:.85rem;
    padding:.8rem 1rem; border-radius:12px;
    background:var(--light); border:1.5px solid transparent;
    transition:all .15s;
  }
  .student-row.present-row  { border-color:#bbf7d0; background:#f0fdf4; }
  .student-row.suspended    { border-color:#f59e0b; border-width:2px; background:#fffbeb; }
  .suspension-badge { 
    font-size:.72rem; font-weight:700; color:#78350f; 
    background:linear-gradient(135deg,#fde68a,#fbbf24); 
    border:1.5px solid #f59e0b; border-radius:6px; 
    padding:.2rem .55rem; display:inline-block; margin-top:.25rem;
    box-shadow: 0 1px 3px rgba(245,158,11,.3);
  }
  .btn-removal { background:#fee2e2; border:1.5px solid #fecaca; border-radius:8px; padding:.4rem .5rem; cursor:pointer; font-size:.85rem; color:#b91c1c; flex-shrink:0; }
  .btn-removal:hover { background:#fecaca; }
  .btn-unlock { background:#f0fdf4; border:1.5px solid #86efac; border-radius:8px; padding:.35rem .75rem; cursor:pointer; font-size:.78rem; color:#15803d; font-weight:600; }
  .student-row.absent-row   { border-color:#fecaca; background:#fef2f2; }
  .student-row.permit-row   { border-color:#fde68a; background:#fffbeb; }
  .student-row.late-row     { border-color:#fed7aa; background:#fff7ed; }
  .student-num { font-size:.75rem; color:var(--gray); width:22px; text-align:right; flex-shrink:0; }
  .student-avatar {
    width:36px; height:36px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-size:.82rem; font-weight:700; color:var(--white); flex-shrink:0;
  }
  .student-name-text { flex:1; font-size:.9rem; font-weight:600; color:var(--navy); }
  .status-btns { display:flex; gap:.3rem; }
  .status-btn {
    border:none; border-radius:8px; padding:.38rem .65rem;
    font-size:.78rem; font-weight:700; cursor:pointer;
    transition:all .15s; opacity:.45;
  }
  .status-btn.active { opacity:1; transform:scale(1.05); }
  .status-btn.btn-p { background:#dcfce7; color:#166534; }
  .status-btn.btn-p.active { background:var(--present); color:var(--white); }
  .status-btn.btn-a { background:#fee2e2; color:#991b1b; }
  .status-btn.btn-a.active { background:var(--absent); color:var(--white); }
  .status-btn.btn-pe { background:#fef9c3; color:#854d0e; }
  .status-btn.btn-pe.active { background:var(--permit); color:var(--white); }
  .obs-btn {
    border:none; border-radius:7px; padding:.35rem .6rem;
    background:none; color:var(--gray); font-size:.85rem;
    cursor:pointer; transition:all .15s;
  }
  .obs-btn:hover { background:var(--light); color:var(--navy); }

  /* === BUTTONS === */
  .btn {
    display:inline-flex; align-items:center; gap:.4rem;
    padding:.6rem 1.1rem; border:none; border-radius:10px;
    font-family:'DM Sans',sans-serif; font-size:.875rem;
    font-weight:600; cursor:pointer; transition:all .2s;
  }
  .btn-primary { background:var(--navy); color:var(--white); }
  .btn-primary:hover { background:var(--teal); transform:translateY(-1px); }
  .btn-teal { background:var(--teal2); color:var(--white); }
  .btn-teal:hover { background:var(--teal); }
  .btn-ghost { background:var(--light); color:var(--navy); border:1.5px solid var(--border); }
  .btn-ghost:hover { background:var(--border); }
  .btn-danger { background:#fef2f2; color:var(--rose); border:1.5px solid #fecaca; }
  .btn-sm { padding:.4rem .75rem; font-size:.8rem; }
  .btn-save-att {
    width:100%; padding:.9rem;
    background:linear-gradient(135deg, var(--teal) 0%, var(--navy) 100%);
    color:var(--white); border:none; border-radius:12px;
    font-family:'DM Sans',sans-serif; font-size:1rem; font-weight:700;
    cursor:pointer; margin-top:1.25rem; transition:all .2s;
    box-shadow:0 4px 16px rgba(11,122,117,.25);
  }
  .btn-save-att:hover { transform:translateY(-1px); box-shadow:0 6px 20px rgba(11,122,117,.35); }
  .btn-save-att:disabled { opacity:.6; cursor:not-allowed; transform:none; box-shadow:none; }

  /* === CASE FORM === */
  .form-group { display:flex; flex-direction:column; gap:.4rem; margin-bottom:.9rem; }
  .form-group label { font-size:.82rem; font-weight:600; color:var(--navy); }
  .form-group input, .form-group select, .form-group textarea {
    padding:.7rem .9rem; border:1.5px solid var(--border); border-radius:10px;
    font-family:'DM Sans',sans-serif; font-size:.9rem; color:var(--navy);
    background:var(--white); outline:none; transition:border-color .2s, box-shadow .2s;
    resize:vertical;
  }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
    border-color:var(--teal2); box-shadow:0 0 0 3px rgba(20,184,176,.12);
  }
  .type-selector { display:grid; grid-template-columns:repeat(3,1fr); gap:.65rem; margin-bottom:.9rem; }
  .type-opt {
    border:2px solid var(--border); border-radius:12px;
    padding:.9rem .75rem; cursor:pointer; text-align:center;
    transition:all .2s;
  }
  .type-opt:hover { border-color:var(--teal2); }
  .type-opt.selected-1 { border-color:var(--gold); background:#fffbeb; }
  .type-opt.selected-2 { border-color:var(--rose); background:#fef2f2; }
  .type-opt.selected-3 { border-color:#7c3aed; background:#f5f3ff; }
  .type-opt-ico { font-size:1.5rem; margin-bottom:.35rem; }
  .type-opt-label { font-size:.8rem; font-weight:700; color:var(--navy); }
  .type-opt-desc { font-size:.72rem; color:var(--gray); margin-top:.2rem; line-height:1.35; }

  /* === HISTORY === */
  .history-item {
    display:flex; align-items:flex-start; gap:.85rem;
    padding:.9rem; border-radius:12px; margin-bottom:.5rem;
    border-left:4px solid var(--border); background:var(--light);
    transition:transform .15s;
  }
  .history-item:hover { transform:translateX(2px); }
  .history-item.t1 { border-left-color:var(--gold); }
  .history-item.t2 { border-left-color:var(--rose); }
  .history-item.t3 { border-left-color:#7c3aed; }
  .history-item.positive { border-left-color:var(--present); }
  .history-ico { font-size:1.2rem; flex-shrink:0; margin-top:.1rem; }
  .history-body { flex:1; min-width:0; overflow-wrap:break-word; }
  .history-title { font-weight:700; font-size:.875rem; color:var(--navy); margin-bottom:.2rem; }
  .history-desc { font-size:.8rem; color:var(--gray); line-height:1.5; }
  .history-meta { font-size:.75rem; color:var(--gray); margin-top:.25rem; display:flex; gap:.75rem; flex-wrap:wrap; }

  /* === PILL === */
  .pill { display:inline-flex; align-items:center; gap:.3rem; padding:.2rem .65rem; border-radius:999px; font-size:.75rem; font-weight:600; }
  .pill-green { background:#dcfce7; color:#166534; }
  .pill-yellow { background:#fef9c3; color:#854d0e; }
  .pill-red { background:#fee2e2; color:#991b1b; }
  .pill-purple { background:#f5f3ff; color:#6d28d9; }

  /* === MODAL === */
  .modal-overlay {
    position:fixed; inset:0; background:rgba(15,31,61,.6);
    z-index:500; display:none; align-items:center; justify-content:center;
    padding:1rem; backdrop-filter:blur(4px);
  }
  .modal-overlay.open { display:flex; }
  .modal {
    background:var(--white); border-radius:20px; width:100%; max-width:480px;
    box-shadow:0 20px 60px rgba(15,31,61,.25); animation:modalIn .25s ease;
    max-height:90vh; display:flex;flex-direction:column;}
  @keyframes modalIn { from{opacity:0;transform:scale(.95)} to{opacity:1;transform:scale(1)} }
  .modal-header {
    padding:1.3rem 1.4rem .9rem; border-bottom:1px solid var(--border);
    display:flex; align-items:center; justify-content:space-between;
    position:sticky; top:0; background:var(--white); z-index:1;
  }
  .modal-header h3 { font-family:'Fraunces',serif; font-size:1.05rem; font-weight:700; color:var(--navy); }
  .modal-close { background:none; border:none; font-size:1.2rem; color:var(--gray); cursor:pointer; padding:.2rem; border-radius:5px; }
  .modal-close:hover { background:var(--light); }
  .modal-body { padding:1.4rem; overflow-y:auto;flex:1;min-height:0;}
  .modal-footer { padding:.85rem 1.4rem 1.3rem; display:flex; justify-content:flex-end; gap:.5rem; flex-shrink:0;position:sticky;bottom:0;background:var(--white);border-top:1px solid var(--border);z-index:2;}

  /* === TOAST === */
  #toast-container { position:fixed; bottom:1.25rem; right:1.25rem; z-index:9999; display:flex; flex-direction:column; gap:.4rem; }
  .toast { background:var(--navy); color:var(--white); border-radius:11px; padding:.7rem 1rem; font-size:.855rem; font-weight:500; box-shadow:0 6px 20px rgba(15,31,61,.2); animation:toastIn .25s ease; display:flex; align-items:center; gap:.45rem; max-width:320px; }
  .toast.success { background:var(--teal); }
  .toast.error   { background:var(--rose); }
  .toast.warning { background:var(--gold); color:var(--navy); }
  @keyframes toastIn { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }

  /* === QUICK MARK ALL === */
  .quick-mark {
    display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom:1rem;
    padding:.75rem 1rem; background:var(--light); border-radius:10px;
    align-items:center;
  }
  .quick-mark-label { font-size:.8rem; font-weight:600; color:var(--gray); margin-right:.25rem; }
  .qm-btn { padding:.38rem .8rem; border:none; border-radius:7px; font-size:.8rem; font-weight:700; cursor:pointer; transition:all .15s; }
  .qm-btn.p { background:var(--present); color:var(--white); }
  .qm-btn.a { background:var(--absent); color:var(--white); }

  /* Responsive — optimizado para móvil en aula */
  /* RESPONSIVE MOBILE */
  @media (max-width:768px) {
    :root { --sidebar:0px; }
    .sidebar { transform:translateX(-100%); transition:transform .3s ease; z-index:200; width:260px; }
    .sidebar.open { transform:translateX(0); }
    .sidebar-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:199; }
    .sidebar-overlay.open { display:block; }
    .main { margin-left:0; }
    .topbar { padding:.7rem 1rem; }
    .content { padding:.85rem; }
    .courses-grid { grid-template-columns:1fr; }
    .att-stats { grid-template-columns:repeat(2,1fr); gap:.45rem; }
    .att-stat { padding:.6rem .5rem; }
    .att-stat span { font-size:1.4rem; }
    #hour-selector { gap:.35rem; }
    #hour-selector button { padding:.5rem .65rem; font-size:.8rem; }
    .student-row { padding:.85rem .75rem; gap:.5rem; }
    .student-name-text { font-size:.83rem; }
    .status-btns { gap:.2rem; }
    .status-btns .status-btn { flex:1; padding:.75rem .2rem; min-width:36px; }
    .btn-save-att { width:100%; justify-content:center; font-size:.9rem; }
    .type-selector { grid-template-columns:1fr; }
    .form-grid-2 { grid-template-columns:1fr; }
    .quick-mark { flex-wrap:wrap; gap:.4rem; }
    .qm-btn { padding:.75rem; font-size:.9rem; flex:1; min-width:80px; }
    .modal-overlay { align-items:flex-end; padding:0; }
    .modal { border-radius:20px 20px 0 0; max-width:100%; max-height:92vh; max-height:92dvh; }
    .status-btn-group { flex-wrap:nowrap; }
    .hamburger { display:flex !important; }

    /* ── Mobile / PWA fixes ── */
    .modal-body table, .card-body table, .section table { width:100%; min-width:0; }
    .modal-body > table, .card-body > table, .section > table { display:block; overflow-x:auto; -webkit-overflow-scrolling:touch; }
    .modal-body input, .modal-body select, .modal-body textarea,
    .modal-body .form-group input, .modal-body .form-group select { width:100%; box-sizing:border-box; }
    .modal-footer { flex-wrap:wrap; }
    .modal-footer .btn { flex:1 1 auto; min-width:100px; text-align:center; }
    body { overflow-x:hidden; }
    .card-body > table, .modal-body > table, .section > table { display:block; overflow-x:auto; -webkit-overflow-scrolling:touch; width:100%; }
    .card-header { flex-wrap:wrap; }
  }

  /* RESPONSIVE SMALL MOBILE */
  @media (max-width:480px) {
    .att-stats { grid-template-columns:repeat(2,1fr); }
    .student-num { display:none; }
    #hour-selector button { padding:.45rem .5rem; font-size:.74rem; }
    .status-btns .status-btn span { font-size:.9rem; }
    /* History cards: stack icon + body + pill on very small screens */
    .history-item { flex-wrap:wrap; gap:.5rem; }
    .history-item .pill { margin-left:0 !important; width:100%; text-align:center; }
    /* Tipo I buttons: full width on small screens */
    .history-item .btn-sm { flex:1 1 auto; min-width:80px; }
    /* Falta preview text wrap */
    #falta-preview { word-break:break-word; }
  }

  .hamburger { display:none; flex-direction:column; gap:4px; background:none; border:none; cursor:pointer; padding:.4rem; }
  .hamburger span { width:22px; height:2px; background:var(--navy); border-radius:2px; transition:all .3s; }

  @media(max-width:480px){
    .card-header .btn { font-size:.76rem; padding:.35rem .6rem; }
    .section-header h2 { font-size:1rem; }
    .section-header { flex-wrap:wrap; gap:.4rem; }
  }
</style>
</head>
<body>

<!-- ===== SIDEBAR ===== -->
<aside class="sidebar">
  <div class="sidebar-brand">
    <img class="sb-logo" id="sb-logo-img" src="" alt="Logo">
    <div class="sb-mark" id="sb-mark-fallback" style="background:#fff;padding:2px;"><img src="/icons/icon-96.png" alt="RAICE" style="width:100%;height:100%;object-fit:contain;"></div>
    <div>
      <div class="sb-name">RAICE</div>
      <div class="sb-role">Docente</div>
    </div>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-group-title">Mis clases</div>
    <button class="nav-item active" onclick="showSection('mis-cursos',this)">
      <span class="nav-ico">🏫</span> Mis cursos
    </button>
    <button class="nav-item" id="nav-pasar-lista" onclick="pasarListaInteligente(this)">
      <span class="nav-ico">📋</span> Pasar lista
    </button>
    <button class="nav-item" onclick="showSection('mi-horario',this)">
      <span class="nav-ico">🕐</span> Mi horario
    </button>
    <button class="nav-item" onclick="showSection('historial-att',this)">
      <span class="nav-ico">📊</span> Historial de asistencia
    </button>

    <div class="nav-group-title">Convivencia</div>
    <button class="nav-item" onclick="showSection('reportar',this)">
      <span class="nav-ico">⚠️</span> Reportar caso
    </button>
    <button class="nav-item" onclick="showSection('historial',this)">
      <span class="nav-ico">📖</span> Historial de casos
    </button>

    <div class="nav-group-title director-only" id="nav-group-mi-grado" style="display:none;">Director de grado</div>
    <button class="nav-item director-only" id="nav-btn-mi-grado" style="display:none;" onclick="showSection('mi-grado',this)">
      <span class="nav-ico">🏅</span> Casos de mi grado
    </button>
    <button class="nav-item director-only" id="nav-btn-excusas" style="display:none;" onclick="showSection('excusas-grado',this)">
      <span class="nav-ico">📋</span> Excusas de mi grado
    </button>

    <div class="nav-group-title">Mi perfil</div>
    <button class="nav-item" onclick="showSection('perfil',this)">
      <span class="nav-ico">👤</span> Mi perfil
    </button>
  </nav>
  <div class="sidebar-footer">
    <div class="user-chip">
      <div class="user-avatar" id="teacher-avatar">TU</div>
      <div style="flex:1;min-width:0;">
        <div class="user-name" id="teacher-name">Docente</div>
        <div class="user-role-badge">👨🏫 Docente</div>
      </div>
    </div>
    <button class="btn-logout" onclick="logout()">🚪 Cerrar sesión</button>
  </div>
</aside>

<!-- ===== SIDEBAR OVERLAY (mobile) ===== -->
<div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>

<!-- ===== MAIN ===== -->
<main class="main">
  <div class="topbar">
    <div style="display:flex;align-items:center;gap:.75rem;">
      <button class="hamburger" onclick="toggleSidebar()" aria-label="Menú">
        <span></span><span></span><span></span>
      </button>
      <div class="page-title" id="page-title">Mis cursos</div>
    </div>
    <div class="topbar-right">
      <button onclick="openMySchedule()" style="background:none;border:1.5px solid var(--border);border-radius:20px;padding:.3rem .75rem;font-size:.78rem;cursor:pointer;font-family:'DM Sans',sans-serif;color:var(--navy);">🗓️ Mi horario</button>
      <div class="topbar-badge">👨🏫 Docente</div>
      <div id="topbar-sede-badge" class="topbar-badge" style="display:none;background:rgba(232,160,32,.12);color:#92400e;border-color:rgba(232,160,32,.3);">🏢 Sede</div>
      <span style="font-size:.8rem;color:var(--gray);" id="topbar-date"></span>
    </div>
  </div>

  <!-- Modal: Mi horario semanal -->
  <div id="modal-my-schedule" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:500;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto;">
    <div style="background:white;border-radius:20px;max-width:700px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2);">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:1.25rem 1.5rem;border-bottom:1px solid #e2e8f0;">
        <h3 style="font-family:'Fraunces',serif;font-size:1.1rem;">🗓️ Mi horario semanal</h3>
        <button onclick="document.getElementById('modal-my-schedule').style.display='none'" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#94a3b8;">✕</button>
      </div>
      <div id="my-schedule-body" style="padding:1.25rem;">
        <div style="text-align:center;padding:2rem;color:#64748b;">Cargando…</div>
      </div>
    </div>
  </div>
  <div class="content">

    <!-- ===== MIS CURSOS ===== -->
    <section class="section active" id="sec-mis-cursos">
      <!-- Banner de día especial / festivo -->
      <div id="holiday-banner" style="display:none;margin-bottom:1.25rem;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#0f1f3d 0%,#7c3aed 100%);box-shadow:0 4px 24px rgba(15,31,61,.18);">
        <div style="padding:1.25rem 1.5rem;display:flex;align-items:center;gap:1.1rem;">
          <div style="font-size:2rem;flex-shrink:0;" id="holiday-banner-icon">🎌</div>
          <div style="flex:1;min-width:0;">
            <div style="font-family:'Fraunces',serif;font-size:1.1rem;font-weight:700;color:#fff;line-height:1.2;" id="holiday-banner-title">Día especial</div>
            <div style="font-size:.8rem;color:rgba(255,255,255,.6);margin-top:.2rem;text-transform:uppercase;letter-spacing:.07em;" id="holiday-banner-sub">Festivo</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div class="holiday-banner-chip" style="background:rgba(255,255,255,.12);border-radius:10px;padding:.4rem .85rem;font-size:.78rem;font-weight:700;color:#f87171;letter-spacing:.04em;">CURSOS OCULTOS</div>
          </div>
        </div>
        <div class="holiday-banner-footer" style="background:rgba(0,0,0,.18);padding:.55rem 1.5rem;font-size:.78rem;color:rgba(255,255,255,.55);">
          El registro de asistencia está deshabilitado para este día.
        </div>
      </div>

      <div style="margin-bottom:1.5rem;">
        <div style="font-family:'Fraunces',serif;font-size:1.5rem;font-weight:700;color:var(--navy);margin-bottom:.3rem;" id="welcome-title">Buenos días 👋</div>
        <div style="font-size:.9rem;color:var(--gray);" id="welcome-sub">Tus clases de hoy, en orden de horario.</div>
      </div>
      <div class="courses-grid" id="courses-grid">
        <div style="color:var(--gray);font-size:.9rem;padding:2rem;text-align:center;grid-column:1/-1;">Cargando tus cursos…</div>
      </div>
    </section>

    <!-- ===== ASISTENCIA ===== -->
    <section class="section" id="sec-asistencia">
      <div id="att-no-course" style="text-align:center;padding:3rem 1rem;">
        <div style="font-size:3rem;margin-bottom:.75rem;">📋</div>
        <div style="font-family:'Fraunces',serif;font-size:1.20rem;font-weight:700;color:var(--navy);margin-bottom:.4rem;">Selecciona un curso</div>
        <div style="color:var(--gray);font-size:.9rem;margin-bottom:1.5rem;">Elige el curso para pasar lista desde "Mis cursos".</div>
        <button class="btn btn-primary" onclick="showSection('mis-cursos',document.querySelector('.nav-item'))">← Ver mis cursos</button>
      </div>

      <div id="att-content" style="display:none;">
        <div class="att-header">
          <div>
            <div class="att-title" id="att-course-title">7°1 — Matemáticas</div>
            <div class="att-date-info" id="att-date-info">Lunes, 27 de enero de 2025</div>
          </div>
          <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
            <input type="date" id="att-date-picker" style="padding:.5rem .75rem;border:1.5px solid var(--border);border-radius:9px;font-family:'DM Sans',sans-serif;font-size:.85rem;color:var(--navy);background:var(--white);outline:none;" onchange="onDateChange()">
            <button class="btn btn-ghost btn-sm" onclick="printAttendance()">🖨️ Imprimir</button>
          </div>
        </div>

        <!-- Selector de hora de clase -->
        <div style="background:var(--white);border:1.5px solid var(--border);border-radius:14px;padding:.85rem 1rem;margin-bottom:1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
          <span style="font-weight:700;font-size:.9rem;color:var(--navy);">🕐 Hora de clase:</span>
          <div id="hour-selector" style="display:flex;gap:.4rem;flex-wrap:wrap;"></div>
          <span style="font-size:.78rem;color:var(--gray);margin-left:auto;" id="att-saved-badge"></span>
        </div>

        <!-- Warning: shown when no schedule is configured for this course -->
        <div id="no-schedule-warn" style="display:none;background:#fef9c3;border:1.5px solid #fbbf24;border-radius:12px;padding:.75rem 1rem;margin-bottom:1rem;font-size:.84rem;font-weight:600;color:#92400e;">
          ⚠️ Este curso no tiene horario configurado para hoy. Configura el horario en el panel de administración para poder registrar asistencia.
        </div>

        <div class="att-stats">
          <div class="att-stat p"><span id="count-p">0</span><div class="att-stat-label">✅ Presentes</div></div>
          <div class="att-stat a"><span id="count-a">0</span><div class="att-stat-label">❌ Ausentes</div></div>
          <div class="att-stat t" style="background:#fff8e1;border-color:#f59e0b;"><span id="count-t" style="color:#f59e0b;">0</span><div class="att-stat-label" style="color:#b45309;">⏰ Tarde</div></div>
          <div class="att-stat pe"><span id="count-pe">0</span><div class="att-stat-label">🤒 Con permiso</div></div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>Lista de estudiantes</h3>
            <div style="display:flex;align-items:center;gap:.4rem;margin-left:auto;">
              <span style="font-size:.75rem;color:var(--gray);">Ordenar:</span>
              <button id="sort-btn-first" onclick="setSortPref('first_name')"
                style="font-size:.75rem;padding:.25rem .6rem;border-radius:6px;border:1.5px solid var(--border);background:var(--light);color:var(--navy);cursor:pointer;font-family:inherit;transition:all .15s;">
                Nombre
              </button>
              <button id="sort-btn-last" onclick="setSortPref('last_name')"
                style="font-size:.75rem;padding:.25rem .6rem;border-radius:6px;border:1.5px solid var(--border);background:var(--light);color:var(--navy);cursor:pointer;font-family:inherit;transition:all .15s;">
                Apellido
              </button>
            </div>
            <div style="width:100%;font-size:.78rem;color:var(--gray);font-style:italic;margin-top:-.2rem;">T = Llegó tarde · tardanza reportada a coordinación</div>
          </div>
          <div class="card-body">
            <div class="quick-mark">
              <span class="quick-mark-label">Marcar todos:</span>
              <button class="qm-btn p" onclick="markAll('P')">✅ Presentes</button>
              <button class="qm-btn a" onclick="markAll('A')">❌ Ausentes</button>
              <button class="qm-btn" id="btn-actividad-especial" onclick="toggleActividadEspecial()" style="background:#fef9c3;border:1.5px solid #fbbf24;color:#92400e;font-weight:700;">📌 Actividad especial</button>
            </div>
            <div id="ae-note-area" style="display:none;padding:.5rem 0 .25rem;">
              <input type="text" id="ae-note-input" maxlength="200"
                placeholder="Describe la actividad, ej: salida a visitar universidades…"
                oninput="_actividadNote=this.value"
                style="width:100%;box-sizing:border-box;padding:.55rem .75rem;border:1.5px solid #fbbf24;border-radius:10px;font-size:.85rem;background:#fffbeb;color:#92400e;outline:none;">
            </div>
            <div class="student-list" id="student-list">
              <div style="text-align:center;padding:2rem;color:var(--gray);">Cargando estudiantes…</div>
            </div>
            <button class="btn-save-att" id="btn-save-att" onclick="previewAttendance()">
              💾 Guardar lista — <span id="btn-hour-label">1ª hora</span>
            </button>
          </div>
        </div>
      </div>
    </section>
`;

const fileContent = fs.readFileSync('public/docente.html', 'utf8');

// Compare the user snippet block with public/docente.html
const startIdx = fileContent.indexOf('<!DOCTYPE html>');
const snippetLen = userSnippet.length;
const fileSnippet = fileContent.substring(startIdx, startIdx + snippetLen);

if (userSnippet === fileSnippet) {
    console.log('COMPLETELY EQUAL!');
} else {
    console.log('DIFFERENT! Lengths:', userSnippet.length, fileSnippet.length);
    // Find first difference
    let diffCharIdx = -1;
    for (let i = 0; i < Math.min(userSnippet.length, fileSnippet.length); i++) {
        if (userSnippet[i] !== fileSnippet[i]) {
            diffCharIdx = i;
            break;
        }
    }
    if (diffCharIdx !== -1) {
        console.log('First diff at char:', diffCharIdx);
        console.log('User chars:', JSON.stringify(userSnippet.substring(diffCharIdx, diffCharIdx + 100)));
        console.log('File chars:', JSON.stringify(fileSnippet.substring(diffCharIdx, diffCharIdx + 100)));
    }
}
