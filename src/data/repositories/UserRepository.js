import { getSupabase } from '../supabaseClient';

export class UserRepository {
  static async findByUsername(username) {
    const sb = getSupabase();
    const { data: user, error } = await sb
      .from('raice_users')
      .select('id, username, first_name, last_name, email, role, subject, sede_id, password_hash, active, must_change_password')
      .eq('username', username.toLowerCase().trim())
      .single();
    return { user, error };
  }

  static async updateLastLogin(userId) {
    const sb = getSupabase();
    return await sb.from('raice_users').update({ last_login: new Date().toISOString() }).eq('id', userId);
  }

  static async getTeacherSedeName(sedeId) {
    const sb = getSupabase();
    try {
      const { data: sd } = await sb.from('raice_sedes').select('name').eq('id', sedeId).maybeSingle();
      return sd ? sd.name : null;
    } catch (_) {
      return null;
    }
  }

  static async getAdminSedes(userId) {
    const sb = getSupabase();
    try {
      const { data: userSedes } = await sb
        .from('raice_user_sedes')
        .select('sede_id')
        .eq('user_id', userId);
      
      if (userSedes && userSedes.length > 0) {
        const sede_ids = userSedes.map(s => s.sede_id);
        const { data: sList } = await sb.from('raice_sedes').select('id, name').in('id', sede_ids);
        const sMap = {};
        (sList || []).forEach(s => { sMap[s.id] = s.name; });
        const sede_names = sede_ids.map(sid => sMap[sid]).filter(Boolean);
        return { sede_ids, sede_names };
      }
    } catch (_) {
      // tabla aún no migrada
    }
    return { sede_ids: null, sede_names: null };
  }
}
