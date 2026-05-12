import { buildServer } from "./server.js";
import { config } from "./config.js";

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { host: config.host, port: config.port },
      "NinoGame Backend 已启动",
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "关闭中…");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
