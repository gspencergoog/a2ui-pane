import fs from 'node:fs';
import path from 'node:path';

export interface CleanupResult {
  deleted: number;
  errors: number;
}

/**
 * Periodically removes stale conversation store files and temporary embed files
 * that have not been modified within the specified retention window (default 30 days).
 */
export function cleanupOldFiles(dataDir: string, maxAgeDays = 30): CleanupResult {
  const result: CleanupResult = { deleted: 0, errors: 0 };
  const targetDirs = [path.join(dataDir, 'conversations'), path.join(dataDir, 'embeds')];

  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoffTime) {
            fs.unlinkSync(filePath);
            result.deleted++;
          }
        } catch (fileErr) {
          console.error(`[cleanup] Failed to delete stale file ${filePath}:`, fileErr);
          result.errors++;
        }
      }
    } catch (dirErr) {
      console.error(`[cleanup] Failed reading directory ${dir}:`, dirErr);
      result.errors++;
    }
  }

  return result;
}
