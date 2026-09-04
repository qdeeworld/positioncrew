import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type AtomicJsonHandle = {
  writeFile?: (data: string, options: { encoding: "utf8" }) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

export type AtomicJsonOperations = {
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<void>;
  open: (path: string, flags: number, mode?: number) => Promise<AtomicJsonHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

const DEFAULT_ATOMIC_JSON_OPERATIONS: AtomicJsonOperations = {
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  open,
  rename,
  unlink,
};

export async function atomicJson(
  path: string,
  value: unknown,
  mode = 0o600,
  operations: AtomicJsonOperations = DEFAULT_ATOMIC_JSON_OPERATIONS,
): Promise<void> {
  const directory = dirname(path);
  await operations.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  let renamed = false;
  try {
    const temporaryHandle = await operations.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    try {
      if (!temporaryHandle.writeFile) throw new Error("Atomic JSON temporary file is not writable");
      await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    await operations.rename(temporary, path);
    renamed = true;

    const directoryHandle = await operations.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!renamed) {
      try {
        await operations.unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}
