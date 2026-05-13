/** /ws/parent: 家长浏览器订阅实时事件流。
 *
 * 握手:
 *   ws://.../ws/parent?token=<家长 JWT>
 *   服务端用 app.jwt.verify 验证 token, 拿 parent_id, 订阅 event_bus
 *   后续 server → 浏览器推:
 *     {type:"hello",     payload:{parent_id, server_time}}
 *     {type:"event",     payload:ParentEvent}
 *     {type:"ping"}       (空载, 保活)
 *
 * 浏览器只读, 不发命令; 命令仍走 REST /api/commands。
 */
import type { FastifyInstance } from "fastify";
import { subscribeParent, subscriberCount } from "./event_bus.js";

interface ParentClaim {
  sub: string;
  username: string;
}

export async function registerParentWebSocket(app: FastifyInstance) {
  app.get("/ws/parent", { websocket: true }, (socket, req) => {
    const url = new URL(req.url || "/", "http://x");
    const token = url.searchParams.get("token");
    if (!token) {
      app.log.warn({ ip: req.ip }, "/ws/parent rejected: missing token");
      try {
        socket.send(JSON.stringify({ type: "error", payload: { reason: "missing_token" } }));
      } catch { /* ignore */ }
      socket.close(4001, "missing_token");
      return;
    }

    let claim: ParentClaim;
    try {
      claim = app.jwt.verify(token) as ParentClaim;
    } catch {
      app.log.warn({ ip: req.ip }, "/ws/parent rejected: invalid token");
      try {
        socket.send(JSON.stringify({ type: "error", payload: { reason: "invalid_token" } }));
      } catch { /* ignore */ }
      socket.close(4002, "invalid_token");
      return;
    }

    const parent_id = claim.sub;

    // 订阅: handler 把事件推给浏览器
    const unsubscribe = subscribeParent(parent_id, (ev) => {
      try {
        socket.send(JSON.stringify({ type: "event", payload: ev }));
      } catch {
        // socket 已断, 忽略
      }
    });

    // 发 hello 让前端知道连接 OK
    try {
      socket.send(
        JSON.stringify({
          type: "hello",
          payload: {
            parent_id,
            username: claim.username,
            server_time: new Date().toISOString(),
            online_subscribers: subscriberCount(parent_id),
          },
        }),
      );
    } catch { /* ignore */ }

    // 保活: 每 30s 推一个 ping
    const ping = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch { /* ignore */ }
    }, 30_000);

    socket.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      app.log.info({ parent_id }, "/ws/parent disconnected");
    });

    socket.on("error", (err: Error) => {
      app.log.warn({ err, parent_id }, "/ws/parent socket error");
    });

    app.log.info({ parent_id, username: claim.username }, "/ws/parent connected");
  });
}
