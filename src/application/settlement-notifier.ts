import type { SettlementRepository, SettlementPort } from '../domain/settlement.js';
import { SettlementReceipt, sameNotice } from '../shared/settlement.js';
export class SettlementNotifier {
  private readonly active = new Set<string>();
  constructor(private readonly repository: SettlementRepository) {}
  async flushOne(port: SettlementPort): Promise<boolean> {
    if (this.active.has(port.profileId)) return false;
    const notice = await this.repository.claim(port.profileId);
    if (!notice) return false;
    if (!notice.claimToken) throw Error('NOTICE_CLAIM_MISSING');
    this.active.add(port.profileId);
    try {
      const receipt = SettlementReceipt.parse(await port.notify(notice.binding, notice.resolution));
      if (!sameNotice(receipt, notice)) throw Error('NOTICE_RECEIPT_MISMATCH');
      await this.repository.delivered(notice.binding.operationId, notice.claimToken, receipt);
    } catch (error) {
      await this.repository.retry(
        notice.binding.operationId,
        notice.claimToken,
        error instanceof Error ? error.message.slice(0, 300) : 'NOTICE_RESULT_UNKNOWN',
      );
    } finally {
      this.active.delete(port.profileId);
    }
    return true;
  }
}
