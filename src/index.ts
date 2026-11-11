import { resolve } from "node:path";
import { ConfigError, applyEnvOverrides, loadConfig } from "./config/load.ts";
import { createServer } from "./http/server.ts";
import { Runtime } from "./runtime.ts";
import { createLogger, parseLogLevel } from "./util/log.ts";

// 有 .env 就加载，没有就安静跳过（Node 的 --env-file-if-exists 会往 stderr 打印提示）
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const VERSION = "0.1.0";
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ACCENT = "\u001b[38;5;179m";
const DIM = "\u001b[38;5;240m";
const RESET = "\u001b[0m";

function paint(code: string, text: string): string {
  return COLOR ? `${code}${text}${RESET}` : text;
}

async function main(): Promise<void> {
  const configPath = resolve(process.env.SWITCHYARD_CONFIG?.trim() || "config.json");
  const dataDir = resolve(process.env.SWITCHYARD_DATA_DIR?.trim() || "data");

  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(configPath);
  } catch (error) {
    const fallback = createLogger({
      level: parseLogLevel(process.env.SWITCHYARD_LOG_LEVEL),
      file: resolve(dataDir, "switchyard.log"),
    });
    if (error instanceof ConfigError) {
      fallback.error(error.message);
      for (const detail of error.details) fallback.error(`  - ${detail}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const overrides = applyEnvOverrides(loaded.config);
  const logFile = loaded.config.log.file.trim();
  const logger = createLogger({
    level: parseLogLevel(process.env.SWITCHYARD_LOG_LEVEL ?? loaded.config.log.level),
    file: logFile ? resolve(logFile) : resolve(dataDir, "switchyard.log"),
  });

  if (loaded.created) logger.info("已生成默认配置文件", { path: configPath });

  const runtime = await Runtime.create({
    configPath,
    dataDir,
    config: loaded.config,
    logger,
    warnings: [...loaded.warnings, ...overrides.warnings],
  });

  const server = createServer(runtime, logger);
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        rejectListen(new Error(`端口 ${runtime.config.port} 已被占用，请修改 config.json 中的 port`));
      } else {
        rejectListen(error);
      }
    };
    server.once("error", onError);
    server.listen(runtime.config.port, runtime.config.host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  server.on("error", (error) => logger.error("server error", { error: error.message }));
  banner(runtime);
  for (const warning of runtime.warnings) logger.warn(warning);
  await runtime.bootstrap();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      logger.warn(`${signal} 重复到达，立即退出`);
      await logger.flush();
      process.exit(1);
    }
    closing = true;
    logger.info(`收到 ${signal}，正在关闭`);

    // 长连接可能让 server.close() 一直等下去，超时后强制退出
    const force = setTimeout(() => {
      logger.warn("等待连接关闭超时，强制退出");
      void logger.flush().finally(() => process.exit(1));
    }, 5_000);
    force.unref();

    server.close();
    try {
      await runtime.shutdown();
      logger.info("已关闭");
    } catch (error) {
      logger.error("关闭时出错", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    } finally {
      clearTimeout(force);
      await logger.flush();
    }
    process.exit(process.exitCode ?? 0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  process.on("uncaughtException", (error) => {
    logger.error("未捕获异常", { error: error.message, stack: error.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("未处理的 Promise 拒绝", { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

function banner(runtime: Runtime): void {
  const host = runtime.config.host === "0.0.0.0" ? "127.0.0.1" : runtime.config.host;
  const base = `http://${host}:${runtime.config.port}`;
  const ui = runtime.config.ui.enabled;

  const row = (label: string, value: string): string => `${paint(DIM, `  ${label.padEnd(9)}`)}${value}`;
  const lines = [
    `${paint(ACCENT, "◈ Switchyard")} ${paint(DIM, `v${VERSION}`)}`,
    row("gateway", `${base}/v1`),
    row("admin", ui ? base : "已关闭（ui.enabled = false）"),
    row("config", `${runtime.configPath}${ui ? "" : paint(DIM, "  ← 唯一配置入口")}`),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
