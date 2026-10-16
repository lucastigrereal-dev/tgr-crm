import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getSessionCookieOptions } from "./cookies";

const request = (protocol: string, forwarded?: string) => ({ protocol, headers: forwarded ? { "x-forwarded-proto": forwarded } : {} }) as unknown as Request;

describe("session cookie options (PIL-014)", () => {
  it("plain HTTP (local pilot) uses SameSite=Lax without Secure, so browsers keep the cookie", () => {
    expect(getSessionCookieOptions(request("http"))).toMatchObject({ sameSite: "lax", secure: false, httpOnly: true, path: "/" });
  });

  it("HTTPS uses SameSite=Lax with Secure (KAN-30: never None, the app is same-origin)", () => {
    expect(getSessionCookieOptions(request("https"))).toMatchObject({ sameSite: "lax", secure: true });
    expect(getSessionCookieOptions(request("http", "https"))).toMatchObject({ sameSite: "lax", secure: true });
  });

  it("never emits SameSite=None, in any protocol", () => {
    for (const r of [request("http"), request("https"), request("http", "https"), request("http", "http")]) {
      expect(getSessionCookieOptions(r).sameSite).toBe("lax");
    }
  });
});
