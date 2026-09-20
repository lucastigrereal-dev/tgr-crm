import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function getLocalStorageRoot(): string | null {
  const configured = process.env.LOCAL_STORAGE_DIRECTORY?.trim();
  return configured ? path.resolve(configured) : null;
}

export function resolveLocalStoragePath(key: string): string {
  const root = getLocalStorageRoot();
  if (!root) throw new Error("Local storage não configurado.");
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.includes("\0") || segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("Storage key inválida.");
  }
  const target = path.resolve(root, ...segments);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error("Storage key inválida.");
  }
  return target;
}
export async function putLocalStorageFile(
  key: string,
  data: Buffer | Uint8Array | string,
): Promise<void> {
  const target = resolveLocalStoragePath(key);
  await mkdir(path.dirname(target), { recursive: true });
  const content =
    typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data);
  await writeFile(target, content, { flag: "wx" });
}

export async function readLocalStorageFile(key: string): Promise<Buffer> {
  return readFile(resolveLocalStoragePath(key));
}
