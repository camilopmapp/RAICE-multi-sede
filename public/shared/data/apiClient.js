/**
 * shared/data/apiClient.js
 * Cliente HTTP unificado para la API de RAICE.
 */
(function(R) {

var API_URL = '/api';

R.createApiClient = function(options) {
  options = options || {};
  var _getToken = options.getToken || function() { return sessionStorage.getItem('raice_token'); };
  var getActiveSede = options.getActiveSede || null;
  var onUnauthorized = options.onUnauthorized || null;

  return async function fetchAPI(path, opts) {
    opts = opts || {};
    var token = _getToken();
    var _skipSedeFilter = opts._skipSedeFilter;
    var fetchOpts = Object.assign({}, opts);
    delete fetchOpts._skipSedeFilter;

    var fullPath = path;
    if (!_skipSedeFilter && getActiveSede) {
      var sede = getActiveSede();
      if (sede && sede.id && (!fetchOpts.method || fetchOpts.method === 'GET')) {
        var sep = path.includes('?') ? '&' : '?';
        fullPath = path + sep + 'sede_filter=' + sede.id;
      }
    }

    try {
      var res = await fetch(API_URL + fullPath, Object.assign({}, fetchOpts, {
        headers: Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token}, fetchOpts.headers || {})
      }));
      var data = await res.json().catch(function() { return {}; });

      if (res.status === 401 && onUnauthorized) {
        onUnauthorized();
        return { ok:false, status:401, data:{} };
      }

      return { ok:res.ok, status:res.status, data:data };
    } catch(err) {
      console.error('fetchAPI error:', path, err);
      return { ok:false, status:0, data:{error:'Error de conexión'} };
    }
  };
};

})(window.RAICE = window.RAICE || {});
