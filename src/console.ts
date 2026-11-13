import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { ApiError } from "./domain.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const cookieName = "pi_console";
const lifetime = 8 * 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    consoleAuthorized: (() => boolean) | null;
  }
}

// Console cookies are opaque, short-lived, and scoped to this API process. The
// browser never keeps the operator's bearer token or any model-provider key.
export function installConsole(
  app: FastifyInstance,
  apiKeys: Record<string, string>,
  origin?: string,
  loginRateLimitMax = 10,
) {
  const keys = Object.entries(apiKeys).map(([key, tenant]) => ({
    hash: digest(key),
    tenant,
  }));
  const sessions = new Map<string, { tenant: string; expires: number }>();
  app.decorateRequest("consoleAuthorized", null);
  const authenticate = (token: string) => {
    const hash = digest(token);
    let tenant: string | undefined;
    for (const key of keys)
      if (timingSafeEqual(key.hash, hash)) tenant = key.tenant;
    return tenant;
  };
  const sameOrigin = (request: FastifyRequest) => {
    if (request.headers["x-pi-console"] !== "1")
      throw new ApiError(
        403,
        "console_origin_required",
        "Use the console on this server",
      );
    const expected = origin ?? `${request.protocol}://${request.host}`;
    if (request.headers.origin !== expected)
      throw new ApiError(
        403,
        "console_origin_required",
        "Console requests must use the same origin",
      );
  };
  app.register(cookie);
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (!reply.hasHeader("Cache-Control"))
      reply.header("Cache-Control", "no-store");
  });
  app.addHook("preValidation", async (request) => {
    const route = request.routeOptions.url;
    if (
      route === "/healthz" ||
      route === "/console/login" ||
      route === "/" ||
      route === "/assets/*" ||
      route === "/favicon.svg"
    )
      return;
    const auth = request.headers.authorization;
    if (auth !== undefined) {
      const tenant = authenticate(
        auth.startsWith("Bearer ") ? auth.slice(7) : "",
      );
      if (!tenant)
        throw new ApiError(
          401,
          "unauthorized",
          "A valid bearer token is required",
        );
      request.tenant = tenant;
      return;
    }
    const session = sessions.get(request.cookies[cookieName] ?? "");
    if (!session || session.expires <= Date.now())
      throw new ApiError(
        401,
        "unauthorized",
        "Sign in with your API token to continue",
      );
    if (request.method !== "GET" && request.method !== "HEAD")
      sameOrigin(request);
    request.tenant = session.tenant;
    const sessionId = request.cookies[cookieName]!;
    request.consoleAuthorized = () =>
      sessions.get(sessionId) === session && session.expires > Date.now();
  });
  app.post(
    "/console/login",
    {
      config: { rateLimit: { max: loginRateLimitMax, timeWindow: 60_000 } },
      schema: {
        body: Type.Object(
          { token: Type.String({ minLength: 24, maxLength: 4096 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      sameOrigin(request);
      const tenant = authenticate((request.body as { token: string }).token);
      if (!tenant)
        throw new ApiError(
          401,
          "unauthorized",
          "That API token was not recognized",
        );
      for (const [id, session] of sessions)
        if (session.expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 4096)
        throw new ApiError(
          503,
          "console_busy",
          "Too many console sessions; try again later",
        );
      sessions.delete(request.cookies[cookieName] ?? "");
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { tenant, expires: Date.now() + lifetime });
      reply.setCookie(cookieName, id, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: origin
          ? origin.startsWith("https:")
          : request.protocol === "https",
        maxAge: lifetime / 1000,
      });
      return { tenant };
    },
  );
  app.get("/console/session", async (request) => ({ tenant: request.tenant }));
  app.post("/console/logout", async (request, reply) => {
    sameOrigin(request);
    sessions.delete(request.cookies[cookieName] ?? "");
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });
  app.addHook("onClose", async () => {
    sessions.clear();
  });

  const root = resolve("dist/client");
  if (existsSync(resolve(root, "index.html"))) {
    app.register(staticFiles, {
      root: resolve(root, "assets"),
      prefix: "/assets/",
      immutable: true,
      maxAge: "1y",
    });
    app.get("/", (_request, reply) => reply.sendFile("index.html", root));
    app.get("/favicon.svg", (_request, reply) =>
      reply.sendFile("favicon.svg", root),
    );
  }
}
