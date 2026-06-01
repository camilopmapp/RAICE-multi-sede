import { getSupabase } from '../../data/supabaseClient';
import { requireRole, logActivity, sendNotification, _dbErr, getAdminSedeIds } from '../../shared/utils/apiHelpers';
import { ReportCaseUseCase } from '../../domain/use-cases/ReportCaseUseCase';
import { CasesRepository } from '../../data/repositories/CasesRepository';

export class CasesController {
  static async handle(req, res, user) {

  }
}
