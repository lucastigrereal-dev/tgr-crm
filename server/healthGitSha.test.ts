import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGitSha, registerHealthRoutes } from "./health";

// CRM-A28: o SHA da imagem aparece em /api/health e como rótulo OCI.
describe("SHA da imagem", () => {
  it("aceita só hex de 7 a 64 caracteres", () => {
    expect(buildGitSha({ GIT_SHA: "A1b2c3d4e5f60718293a4b5c6d7e8f9012345678" } as never)).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    for (const bad of [undefined, "", "unknown", "xyz", "abc12", "<script>"]) expect(buildGitSha({ GIT_SHA: bad } as never)).toBe("unknown");
  });
  it("/api/health/live devolve gitSha", async () => {
    process.env.GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    const routes = new Map<string, (req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => unknown>();
    registerHealthRoutes({ get: (path: string, handler: never) => { routes.set(path, handler); } } as never);
    let body: Record<string, unknown> = {};
    await routes.get("/api/health/live")!({}, { status: () => ({ json: (b: unknown) => { body = b as Record<string, unknown>; } }) });
    expect(body.gitSha).toBe("0123456789abcdef0123456789abcdef01234567");
    delete process.env.GIT_SHA;
  });
  it("Dockerfile grava o rótulo OCI e o compose repassa o build-arg", () => {
    const dockerfile = readFileSync(join(__dirname, "..", "infra/pilot/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/ARG GIT_SHA/);
    expect(dockerfile).toMatch(/LABEL org\.opencontainers\.image\.revision=\$GIT_SHA/);
    expect(readFileSync(join(__dirname, "..", "infra/pilot/docker-compose.yml"), "utf8")).toMatch(/GIT_SHA: "\$\{GIT_SHA:-unknown\}"/);
  });
});
