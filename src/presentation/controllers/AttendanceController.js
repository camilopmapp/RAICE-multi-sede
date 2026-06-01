import { getSupabase } from '../../data/supabaseClient';
import { requireRole, logActivity, sendNotification, reevaluateEvasions, getAllowedCourseIdsForAdmin, _dbErr } from '../../shared/utils/apiHelpers';
import { todayCO } from '../../shared/utils/date';
import { RegisterAttendanceUseCase } from '../../domain/use-cases/RegisterAttendanceUseCase';

export class AttendanceController {
  static async handle(req, res, user) {

  }
}
