import { CasesRepository } from '../../data/repositories/CasesRepository';

export class ReportCaseUseCase {
  /**
   * Registra un caso de convivencia y orquesta el envío de notificaciones y logs.
   * @param {Object} params - Datos del caso (student_id, type, description, etc).
   * @param {Object} user - Usuario autenticado que registra el caso.
   * @param {Object} dependencies - Funciones inyectadas para side-effects (notifyAdminsFn, logActivityFn).
   */
  static async execute(params, user, { notifyAdminsFn, logActivityFn }) {
    if (!params.student_id || !params.type || !params.description) {
      return { error: 'Datos incompletos', status: 400 };
    }

    // 1. Persistir el caso en la base de datos a través del Repositorio
    const { caseData, student, error } = await CasesRepository.createCase(params, user.id);
    if (error) {
      return { error: 'Error al registrar caso', detail: error.message || error.details || '', status: 500 };
    }

    const type = params.type;
    const falta_numeral = params.falta_numeral;

    // 2. Formatear notificaciones según reglas de negocio
    const notifTitle = type === 1
      ? `[Informativo] Caso Tipo I — ${student?.first_name} ${student?.last_name}`
      : `Nuevo caso Tipo ${type} — ${student?.first_name} ${student?.last_name}`;
      
    const notifBody = type === 1
      ? `Docente ${user.username} inició seguimiento · ${student?.grade}°${student?.course}${falta_numeral ? ` · Falta ${falta_numeral}` : ''}`
      : `Reportado por ${user.username} · ${student?.grade}°${student?.course}`;

    // Ejecutar inyecciones de dependencias para side-effects
    // Notificar a todos los coordinadores (admins)
    if (notifyAdminsFn) {
      const notifType = type === 1 ? 'info_tipo1' : 'new_case';
      await notifyAdminsFn(notifType, notifTitle, notifBody, caseData.id);
    }

    // 3. Registrar auditoría (Log)
    if (logActivityFn) {
      const logBody = `Caso Tipo ${type} registrado para ${student?.first_name} ${student?.last_name}${falta_numeral ? ` (Falta ${falta_numeral})` : ''}`;
      await logActivityFn('create_case', logBody);
    }

    return { success: true, caseData, status: 200 };
  }
}
