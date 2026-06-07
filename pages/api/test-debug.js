import { createClient } from '@supabase/supabase-js';

function todayCO(offsetDays = 0) {
  const d = offsetDays === 0
    ? new Date()
    : new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
}

function dayOfWeekCO(dateStr) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  const jsDay = d.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

export default async function handler(req, res) {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const today = todayCO();
  const todayDow = dayOfWeekCO(today);
  const weekMonday = todayCO(-(todayDow - 1));
  const weekFriday = todayCO(5 - todayDow);
  const attThrough = weekFriday > today ? today : weekFriday;

  const serverTime = new Date().toString();
  const serverTimeISO = new Date().toISOString();

  // Query database for attendance of this week
  const attRes = await sb.from('raice_attendance')
    .select('course_id, class_hour, teacher_id, date, status')
    .gte('date', weekMonday)
    .lte('date', attThrough)
    .not('status', 'in', '("NR","PE")')
    .limit(100); // limit to 100 for display

  // Query database for today's attendance specifically
  const todayAttRes = await sb.from('raice_attendance')
    .select('course_id, class_hour, teacher_id, date, status')
    .eq('date', today)
    .limit(100);

  const attSet = (attRes.data || []).map(a =>
    `${a.course_id}_${a.class_hour}_${dayOfWeekCO(a.date)}`
  );

  return res.status(200).json({
    debug: {
      serverTime,
      serverTimeISO,
      today,
      todayDow,
      weekMonday,
      weekFriday,
      attThrough,
      attResCount: attRes.data?.length || 0,
      attResError: attRes.error,
      todayAttCount: todayAttRes.data?.length || 0,
      todayAttError: todayAttRes.error,
      keysInAttSet: attSet.slice(0, 20),
      todayAttRawSample: (todayAttRes.data || []).slice(0, 10)
    }
  });
}
