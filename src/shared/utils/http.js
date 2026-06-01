/**
 * Helper: log DB error server-side, return a safe generic string to the client
 */
export function _dbErr(error, context = '') {
  if (error) console.error(`[RAICE DB${context ? ' ' + context : ''}]`, error.message);
  return 'Error interno del servidor';
}
