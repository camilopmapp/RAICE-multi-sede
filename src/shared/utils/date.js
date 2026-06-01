/**
 * Returns the current date in Colombia (America/Bogota, UTC-5) as YYYY-MM-DD.
 * All "today" calculations must use this helper so the server never
 * drifts to a different date than what teachers and coordinators see.
 * @param {number} [offsetDays=0] - optional offset in days (negative = past)
 */
export function todayCO(offsetDays = 0) {
  const d = offsetDays === 0
    ? new Date()
    : new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
}

/**
 * Given a YYYY-MM-DD date string, returns the day of week in Colombia timezone.
 * Returns 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
 * (matches the day_of_week values stored in raice_schedules)
 */
export function dayOfWeekCO(dateStr) {
  // Parse the date at noon Colombia time to avoid any UTC day-boundary issues
  const d = new Date(new Date(`${dateStr}T12:00:00`).toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const jsDay = d.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  return jsDay === 0 ? 7 : jsDay; // convert to 1=Mon, 7=Sun
}
