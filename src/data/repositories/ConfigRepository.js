import { getSupabase } from '../supabaseClient';

export class ConfigRepository {
  /**
   * Obtiene la configuración global de la plataforma (id=1).
   */
  static async getConfig() {
    const sb = getSupabase();
    const { data } = await sb.from('raice_config').select('*').eq('id', 1).maybeSingle();
    const config = data || {};
    
    // Parse periods_config if it's a JSON string
    if (config.periods_config && typeof config.periods_config === 'string') {
      try { config.periods_config = JSON.parse(config.periods_config); } catch (_) {}
    }
    return config;
  }

  /**
   * Actualiza la configuración global.
   */
  static async updateConfig(updates) {
    const sb = getSupabase();
    
    // Validate correction_window_hour format if present
    if (updates.correction_window_hour !== undefined && updates.correction_window_hour !== null) {
      const hourStr = String(updates.correction_window_hour).trim();
      if (!/^\d{2}:\d{2}$/.test(hourStr)) {
        return { error: 'Formato de hora inválido. Use HH:MM (ej: 17:00)', status: 400 };
      }
      updates.correction_window_hour = hourStr;
    }

    const { data: existing } = await sb.from('raice_config').select('id').eq('id', 1).maybeSingle();
    let error;
    if (existing) {
      ({ error } = await sb.from('raice_config').update(updates).eq('id', 1));
    } else {
      ({ error } = await sb.from('raice_config').insert({ id: 1, ...updates }));
    }

    if (error) return { error: error.message || 'Error al actualizar la configuración', status: 500 };
    return { success: true };
  }
}
