import { z } from 'zod';
export const FileLocationResult = z
  .object({ ok: z.boolean(), error: z.string().max(300) })
  .strict();
export const LocalFileLocationRequest = z.object({ source: z.string().min(1).max(4096) }).strict();
export interface DesktopBridge {
  onBeforeClose(callback: () => Promise<boolean>): () => void;
  chooseMaterialDirectory(): Promise<string | null>;
  chooseBackupDirectory(): Promise<string | null>;
  chooseRestoreBackup(): Promise<string | null>;
  restartSoftware(): Promise<void>;
  materialFilePath(file: File): string;
  revealLocalFile(source: string): Promise<z.infer<typeof FileLocationResult>>;
}
