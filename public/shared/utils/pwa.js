/**
 * shared/utils/pwa.js
 * Funciones PWA compartidas: banners de actualización y conexión.
 */
(function(R) {

R.showUpdateBanner = function() {
  var b = document.getElementById('pwa-update-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'pwa-update-banner';
    b.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);z-index:99999;background:#0f1f3d;color:#fff;border-radius:14px;padding:.75rem 1.25rem;font-size:.82rem;font-weight:600;display:flex;align-items:center;gap:.75rem;box-shadow:0 4px 20px rgba(0,0,0,.3);';
    b.innerHTML = '✨ Nueva versión disponible <button onclick="location.reload()" style="background:#14b8b0;border:none;color:#fff;padding:.3rem .8rem;border-radius:8px;cursor:pointer;font-weight:700;">Actualizar</button>';
    document.body.appendChild(b);
  }
};

R.showOfflineBanner = function() {
  var b = document.getElementById('pwa-offline-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'pwa-offline-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;text-align:center;padding:.55rem 1rem;font-size:.82rem;font-weight:700;letter-spacing:.02em;';
    b.innerHTML = '📡 Sin conexión — mostrando datos guardados';
    document.body.prepend(b);
  }
  b.style.display = 'block';
};

R.hideOfflineBanner = function() {
  var b = document.getElementById('pwa-offline-banner');
  if (b) b.style.display = 'none';
};

})(window.RAICE = window.RAICE || {});
