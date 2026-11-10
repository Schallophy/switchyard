import { resolve } from "node:path";
import { ConfigError, applyEnvOverrides, loadConfig } from "./config/load.ts";
import { createServer } from "./http/server.ts";
import { Runtime } from "./runtime.ts";
import { createLogger, parseLogLevel } from "./util/log.ts";

const VERSION = "0.1.0";
const ACCENT = "\u001b[38;5;179m";
const DIM = "\u001b[38;5;240m";
const RESET = "\u001b[0m";

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

  for (const warning of runtime.warnings) logger.warn(warning);

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
  await runtime.bootstrap();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info("正在关闭", { signal });
    server.close();
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("未捕获异常", { error: error.message, stack: error.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("未处理的 Promise 拒绝", { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

function banner(runtime: Runtime): void {
  const infos = runtime.providerKeyInfos();
  const configured = infos.filter((item) => item.configured);
  const host = runtime.config.host === "0.0.0.0" ? "127.0.0.1" : runtime.config.host;
  const base = `http://${host}:${runtime.config.port}`;
  const ui = runtime.config.ui.enabled;
  const providers =
    runtime.config.providers.length === 1
      ? `${runtime.config.providers[0].id} · ${runtime.config.providers[0].baseUrl}`
      : `${runtime.config.providers.length} 个：${runtime.config.providers.map((item) => item.id).join(", ")}`;
  const auth =
    infos.length === 1
      ? configured.length > 0
        ? `${configured[0].source === "env" ? "环境变量" : "config.json"} · ${configured[0].masked}`
        : "未配置 · 按需再填即可"
      : `${configured.length}/${infos.length} 个提供商已配置`;
  const lines = [
    `${ACCENT}◈ Switchyard${RESET} ${DIM}v${VERSION}${RESET}`,
    `${DIM}  gateway  ${RESET}${base}/v1`,
    `${DIM}  admin    ${RESET}${ui ? base : "已关闭（ui.enabled = false）"}`,
    `${DIM}  config   ${RESET}${runtime.configPath}${ui ? "" : DIM + "  ← 唯一配置入口" + RESET}`,
    `${DIM}  provider ${RESET}${providers}`,
    `${DIM}  auth     ${RESET}${auth}`,
    `${DIM}  models   ${RESET}${runtime.chainCodes().length} 个模型 · 当前 ${runtime.activeModel() ?? "未选择"}`,
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
