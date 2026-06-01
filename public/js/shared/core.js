// Core UI Utils for RAICE portals (admin, rector, docente)

// HTML escape — prevent XSS when inserting user data into innerHTML
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Returns today's date string (YYYY-MM-DD) in Colombia timezone (UTC-5)
function todayColombia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

// ---- MODAL ----
function openModal(id)  { const m = document.getElementById(id); if (m) m.classList.add('open'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); }

// ---- SIDEBAR TOGGLE (mobile) ----
function toggleSidebar() {
  const sb  = document.getElementById('main-sidebar');
  const ov  = document.getElementById('sidebar-overlay');
  if (!sb || !ov) return;
  const isOpen = sb.classList.toggle('open');
  ov.classList.toggle('open', isOpen);
}

document.addEventListener('DOMContentLoaded', () => {
  // Close sidebar when a nav item is clicked on mobile
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        const sb = document.getElementById('main-sidebar');
        const ov = document.getElementById('sidebar-overlay');
        if (sb) sb.classList.remove('open');
        if (ov) ov.classList.remove('open');
      }
    });
  });
});

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ---- TOAST ----
function showToast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const ico = {success:'✅',error:'❌',warning:'⚠️'}[type]||'ℹ️';
  t.innerHTML = `<span>${ico}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ---- HELPERS ----
function avatarColor(name) {
  const c = ['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#0b7a75','#ec4899'];
  return c[(name||'A').charCodeAt(0) % c.length];
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', {day:'2-digit',month:'short',year:'numeric'});
}

function daysAgo(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d === 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`;
}

// Fetch wrapper for authenticated requests
async function fetchAPI(path, opts = {}) {
  const token = sessionStorage.getItem('raice_token') || sessionStorage.getItem('TOKEN');
  // Extraer flag interno (no se envía al servidor)
  const { _skipSedeFilter, ...fetchOpts } = opts;
  // Inyectar sede_filter automáticamente en GETs cuando hay una sede activa seleccionada.
  let fullPath = path;
  if (!_skipSedeFilter && typeof activeSede !== 'undefined' && activeSede && activeSede.id && (!fetchOpts.method || fetchOpts.method === 'GET')) {
    const sep = path.includes('?') ? '&' : '?';
    fullPath = path + sep + 'sede_filter=' + activeSede.id;
  }
  try {
    const apiUrl = typeof API_URL !== 'undefined' ? API_URL : '/api';
    const res = await fetch(apiUrl + fullPath, {
      ...fetchOpts,
      headers: {'Content-Type':'application/json','Authorization':`Bearer ${token}`,...(fetchOpts.headers||{})}
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('fetchAPI error:', path, err);
    return { ok: false, status: 0, data: { error: 'Error de conexión' } };
  }
}
