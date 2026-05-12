import { buildServer } from "./server.js";
import { config } from "./config.js";

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(
      { host: config.host, port: config.port },
      "NinoGame Backend started",
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down...");
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
  console.error("startup failed:", err);
  process.exit(1);
});
