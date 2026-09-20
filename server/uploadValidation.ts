import { TRPCError } from "@trpc/server";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function decodeUpload(base64: string) {
  const commaIndex = base64.indexOf(",");
  const payload = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  const invalid = !payload || payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload);
  if (invalid) throw new TRPCError({ code: "BAD_REQUEST", message: "O conteúdo do anexo não é um base64 válido." });

  const buffer = Buffer.from(payload, "base64");
  const canonical = buffer.toString("base64").replace(/=+$/, "");
  const normalized = payload.replace(/=+$/, "");
  if (!buffer.length || canonical !== normalized) throw new TRPCError({ code: "BAD_REQUEST", message: "O conteúdo do anexo não é um base64 válido." });
  if (buffer.length > MAX_UPLOAD_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: "O anexo deve ter até 5 MB." });
  return buffer;
}
