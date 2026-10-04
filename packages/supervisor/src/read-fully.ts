import type { FileHandle } from "node:fs/promises";

/** Reads into `buffer` from the start until it is full or the file ends; the number of bytes read. */
export async function readFully(handle: FileHandle, buffer: Buffer): Promise<number> {
  let count = 0;
  while (count < buffer.length) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  return count;
}
