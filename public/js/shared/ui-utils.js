// Utilidades de Interfaz Gráfica (RAICE)

function togglePass() {
  const inp = document.getElementById('password');
  if (inp) {
    inp.type = inp.type === 'password' ? 'text' : 'password';
    const btn = document.getElementById('btn-show-pass');
    if (btn) btn.textContent = inp.type === 'password' ? '👁️' : '🙈';
  }
}

function showAlert(type, msg) {
  const box = document.getElementById('alert-box');
  if (box) {
    box.className = 'alert-box ' + type;
    const ico = document.getElementById('alert-ico');
    if (ico) ico.textContent = type === 'error' ? '❌' : '✅';
    const msgEl = document.getElementById('alert-msg');
    if (msgEl) msgEl.textContent = msg;
  }
}

function clearAlert() {
  const box = document.getElementById('alert-box');
  if (box) box.className = 'alert-box';
}

function setLoading(on) {
  const btn = document.getElementById('btn-login');
  if (btn) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }
}
