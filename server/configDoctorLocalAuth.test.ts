import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("config doctor local pilot profile", () => {
  it("aceita auth e storage locais sem exigir OAuth ou Forge", () => {
    const env = {
      ...process.env,
      DATABASE_URL: "mysql://tgr:secret@127.0.0.1:3306/tgr_crm_pilot",
      JWT_SECRET: "local-pilot-secret-with-at-least-32-characters",
      VITE_APP_ID: "tgr-crm-pilot",
      LOCAL_AUTH_ENABLED: "1",
      LOCAL_AUTH_USERNAME: "syn.admin",
      LOCAL_AUTH_PASSWORD_HASH: "scrypt:00112233445566778899aabbccddeeff:" + "ab".repeat(64),
      LOCAL_STORAGE_DIRECTORY: "C:/tgr-private-storage",
      OAUTH_SERVER_URL: "",
      OWNER_OPEN_ID: "",
      BUILT_IN_FORGE_API_URL: "",
      BUILT_IN_FORGE_API_KEY: "",
    };

    const result = spawnSync(
      process.execPath,
      ["scripts/config-doctor.mjs", "--strict"],
      { cwd: root, env, encoding: "utf8", timeout: 5_000 },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
    expect(output).toContain("perfil=strict");
    expect(output).not.toContain("OAUTH_SERVER_URL ausente");
    expect(output).not.toContain("BUILT_IN_FORGE_API_URL ausente");
    expect(output).toContain("ASAAS_API_KEY ausente");
  });

  it("KAN-31: avisa quando há chave Asaas sem ASAAS_API_URL explícita https", () => {
    const env = {
      ...process.env,
      DATABASE_URL: "mysql://tgr:secret@127.0.0.1:3306/tgr_crm_pilot",
      JWT_SECRET: "local-pilot-secret-with-at-least-32-characters",
      VITE_APP_ID: "tgr-crm-pilot",
      LOCAL_AUTH_ENABLED: "1",
      LOCAL_AUTH_USERNAME: "syn.admin",
      LOCAL_AUTH_PASSWORD_HASH: "scrypt:00112233445566778899aabbccddeeff:" + "ab".repeat(64),
      LOCAL_STORAGE_DIRECTORY: "C:/tgr-private-storage",
      ASAAS_API_KEY: "SYN-not-a-real-key",
      ASAAS_API_URL: "",
    };
    const result = spawnSync(process.execPath, ["scripts/config-doctor.mjs", "--strict"], { cwd: root, env, encoding: "utf8", timeout: 5_000 });
    const output = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
    expect(output).toContain("ASAAS_API_URL ausente ou não-https");
  });

  it("GAP-1: valida LOCAL_AUTH_USERS sem imprimir os hashes", () => {
    const base = {
      ...process.env,
      DATABASE_URL: "mysql://tgr:secret@127.0.0.1:3306/tgr_crm_pilot",
      JWT_SECRET: "local-pilot-secret-with-at-least-32-characters",
      VITE_APP_ID: "tgr-crm-pilot",
      LOCAL_AUTH_ENABLED: "1",
      LOCAL_AUTH_USERNAME: "syn.admin",
      LOCAL_AUTH_PASSWORD_HASH: "scrypt:00112233445566778899aabbccddeeff:" + "ab".repeat(64),
      LOCAL_STORAGE_DIRECTORY: "C:/tgr-private-storage",
    };
    const run = (users: string) => {
      const result = spawnSync(process.execPath, ["scripts/config-doctor.mjs", "--strict"], { cwd: root, env: { ...base, LOCAL_AUTH_USERS: users }, encoding: "utf8", timeout: 5_000 });
      return { status: result.status, output: `${result.stdout ?? ""}
${result.stderr ?? ""}` };
    };
    const validHash = "scrypt:ffeeddccbbaa99887766554433221100:" + "cd".repeat(64);
    const ok = run(JSON.stringify([{ username: "syn.finance", role: "finance", passwordHash: validHash }]));
    expect(ok.status).toBe(0);
    expect(ok.output).not.toContain("LOCAL_AUTH_USERS");

    const bad = run(JSON.stringify([{ username: "syn.finance", role: "superadmin", passwordHash: validHash }]));
    expect(bad.status).not.toBe(0);
    expect(bad.output).toContain("LOCAL_AUTH_USERS inválido");
    expect(bad.output).not.toContain("cdcdcd");
  });
});
