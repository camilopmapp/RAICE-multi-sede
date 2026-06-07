/**
 * shared/data/apiClient.js
 * Cliente HTTP unificado para la API de RAICE.
 * Maneja autenticación, inyección de sede_filter y manejo de errores de red.
 */

const API_URL = '/api';

/**
 * Crea un cliente API configurado para un rol específico.
 *
 * @param {Object} options
 * @param {function(): string|null} [options.getToken] — Devuelve el token JWT. Default: sessionStorage.
 * @param {function(): {id:string}|null} [options.getActiveSede] — Devuelve la sede activa (para inyectar sede_filter). Null si no aplica.
 * @param {function(): void} [options.onUnauthorized] — Callback ante respuesta 401. Ej: redirigir al login.
 */
export function createApiClient({ getToken, getActiveSede, onUnauthorized } = {}) {
  const _getToken = getToken || (() => sessionStorage.getItem('raice_token'));

  /**
   * Realiza una petición autenticada a la API de RAICE.
   *
   * @param {string} path — Ruta relativa (ej: '/raice/dashboard')
   * @param {Object} [opts] — Opciones de fetch + flags internos
   * @param {boolean} [opts._skipSedeFilter] — Si true, no inyecta sede_filter (uso interno)
   * @returns {Promise<{ok: boolean, status: number, data: Object}>}
   */
  async function fetchAPI(path, opts = {}) {
    const token = _getToken();
    const { _skipSedeFilter, ...fetchOpts } = opts;

    let fullPath = path;
    if (!_skipSedeFilter && getActiveSede) {
      const sede = getActiveSede();
      if (sede && sede.id && (!fetchOpts.method || fetchOpts.method === 'GET')) {
        const sep = path.includes('?') ? '&' : '?';
        fullPath = path + sep + 'sede_filter=' + sede.id;
      }
    }

    try {
      const res = await fetch(API_URL + fullPath, {
        ...fetchOpts,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          ...(fetchOpts.headers || {})
        }
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401 && onUnauthorized) {
        onUnauthorized();
        return { ok: false, status: 401, data: {} };
      }

      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      console.error('fetchAPI error:', path, err);
      return { ok: false, status: 0, data: { error: 'Error de conexión' } };
    }
  }

  return fetchAPI;
}
