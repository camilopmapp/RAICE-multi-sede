/**
 * shared/data/realtime.js
 * Setup de Supabase Realtime compartido.
 * Cada vista solo define qué canales/tablas escuchar y qué callbacks ejecutar.
 */
(function(R) {

/**
 * Inicializa Supabase Realtime cargando el SDK dinámicamente.
 *
 * @param {function} fetchFn — función fetchAPI/api del módulo que llama
 * @param {Array<{channel:string, table:string, callback:function}>} subscriptions — canales a suscribir
 * @param {string} [label] — etiqueta para el log (ej: 'Rector', 'Admin')
 */
R.initRealtime = function(fetchFn, subscriptions, label) {
  label = label || 'App';
  (async function() {
    try {
      var result = await fetchFn('/raice/realtime-config');
      var data = result.data || result;
      if (!result.ok || !data.supabase_url || !data.supabase_anon_key) return;

      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = function() {
        var sb = window.supabase.createClient(data.supabase_url, data.supabase_anon_key);
        console.log('🔗 Suscribiendo a eventos en tiempo real (' + label + ')...');

        subscriptions.forEach(function(sub) {
          sb.channel(sub.channel)
            .on('postgres_changes', { event: '*', schema: 'public', table: sub.table }, sub.callback)
            .subscribe();
        });
      };
      document.body.appendChild(script);
    } catch (err) {
      console.warn('Realtime init error:', err);
    }
  })();
};

})(window.RAICE = window.RAICE || {});
