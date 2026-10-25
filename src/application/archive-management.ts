import type { ArchiveManagementRepository } from '../domain/archive-management.js';
import type { MaterialArchiveWorker } from './material-archive-worker.js';
import {
  ArchiveListRequest,
  ArchiveManagementList,
  ArchiveResumeRequest,
  ArchiveResumeResult,
} from '../shared/archive-management.js';
import { ProductError } from '../domain/workspace.js';

export class ArchiveManagementService {
  constructor(
    private readonly repository: ArchiveManagementRepository,
    private readonly worker: () => MaterialArchiveWorker | undefined,
  ) {}
  async list(input: unknown) {
    const request = ArchiveListRequest.parse(input);
    return ArchiveManagementList.parse({
      ...(await this.repository.listForPlan(request.profileId, request.planId)),
      executionEnabled: !!this.worker(),
    });
  }
  async resume(input: unknown) {
    const request = ArchiveResumeRequest.parse(input);
    const worker = this.worker();
    if (!worker)
      throw new ProductError('ARCHIVE_EXECUTION_UNAVAILABLE', '当前服务未启用归档执行', 409);
    await this.repository.assertResume(request);
    try {
      worker.resume(request.attemptId, async () => await this.repository.assertResume(request));
    } catch (error) {
      if (
        error instanceof Error &&
        ['ARCHIVE_WORKER_BUSY', 'ARCHIVE_WORKER_STOPPED'].includes(error.message)
      )
        throw new ProductError(error.message, '归档执行器正在处理其他文件，请稍后重新读取', 409);
      throw error;
    }
    // Accepted is not completion. Original IO journal and source checks decide the result.
    return ArchiveResumeResult.parse({ accepted: true, attemptId: request.attemptId });
  }
}
