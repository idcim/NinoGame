import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** JWT claim 形状 */
export interface ParentClaim {
  sub: string;       // parent UUID
  username: string;
  iat?: number;
  exp?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    parent?: ParentClaim;
  }
}

/** 要求请求头携带合法家长 JWT, 解析后挂到 request.parent。

  用法:
    app.get("/protected", { preHandler: app.parentAuth }, handler)
*/
export async function registerParentAuth(app: FastifyInstance) {
  app.decorate(
    "parentAuth",
    async function (req: FastifyRequest, reply: FastifyReply) {
      const header = req.headers["authorization"];
      if (!header || typeof header !== "string" || !header.startsWith("Bearer ")) {
        return reply.unauthorized("缺少 Bearer token");
      }
      const token = header.slice("Bearer ".length).trim();
      try {
        const claim = (await req.jwtVerify({ onlyCookie: false })) as ParentClaim;
        req.parent = claim;
      } catch {
        return reply.unauthorized("token 无效或过期");
      }
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    parentAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
