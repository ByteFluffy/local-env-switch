import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function validateRuntimeId(value: string): string {
  const runtimeId = value.trim();
  if (!/^local-[a-f0-9]{16,}$/.test(runtimeId)) {
    throw new Error('Invalid runtime id file. Delete it and run local-env-switch use again.');
  }
  return runtimeId;
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function getOrCreateRuntimeId(
  filePath: string,
  createCandidate: () => string,
): Promise<string> {
  const existing = await readOptionalFile(filePath);
  if (existing !== null) return validateRuntimeId(existing);

  const candidate = validateRuntimeId(createCandidate());
  try {
    await writeFile(filePath, `${candidate}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return candidate;
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    const raced = await readFile(filePath, 'utf8');
    return validateRuntimeId(raced);
  }
}

export async function atomicWritePrivateFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrorCode(cleanupError, 'ENOENT')) throw cleanupError;
    }
    throw error;
  }
}
