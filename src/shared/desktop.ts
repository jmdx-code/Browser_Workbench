import { z } from 'zod';
import { sMax, sReq, strictObj } from './contracts.js';
export const FileLocationResult = strictObj({ ok: z.boolean(), error: sMax(300) });
export const LocalFileLocationRequest = strictObj({ source: sReq(4096) });
export interface DesktopBridge {
  onBeforeClose(callback: () => Promise<boolean>): () => void;
  chooseBackupDirectory(): Promise<string | null>;
  chooseRestoreBackup(): Promise<string | null>;
  chooseFeedbackDirectory?(): Promise<string | null>;
  restartSoftware(): Promise<void>;
  materialFilePath(file: File): string;
  revealLocalFile(source: string): Promise<z.infer<typeof FileLocationResult>>;
  getAutoLaunch?(): Promise<{ supported: boolean; enabled: boolean }>;
  setAutoLaunch?(enabled: boolean): Promise<{ supported: boolean; enabled: boolean }>;
}
