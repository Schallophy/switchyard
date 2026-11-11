import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ConfigError, applyEnvOverrides, loadConfig } from "./config/load.ts";
import { DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_MAX_FILES } from "./config/schema.ts";
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
      maxBytes: DEFAULT_LOG_MAX_BYTES,
      maxFiles: DEFAULT_LOG_MAX_FILES,
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
    maxBytes: loaded.config.log.maxBytes,
    maxFiles: loaded.config.log.maxFiles,
  });

  if (loaded.created) logger.info("已生成默认配置文件", { path: configPath });

  const runtime = await Runtime.create({
    configPath,
    dataDir,
    config: loaded.config,
    logger,
    warnings: [
      ...loaded.warnings,
      // 不能安全重写（有注释/尾逗号）时仍然提示；能写回的话只在下面打一条 info
      ...(loaded.persisted ? [] : loaded.migrations),
      ...overrides.warnings,
    ],
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
  if (loaded.persisted) logger.info(`配置已迁移为新格式，写回 ${configPath}`);
  for (const warning of runtime.warnings) logger.warn(warning);
  await runtime.bootstrap();

  let closing = false;
  let reloading = false;
  let reloadTimer: NodeJS.Timeout | null = null;

  const reloadConfig = async (reason: string): Promise<void> => {
    if (closing || reloading) return;
    reloading = true;
    try {
      // 删除或保存过程中会短暂读不到文件；此时保持当前配置，不要生成默认配置
      await stat(configPath);
      const next = await loadConfig(configPath);
      if (JSON.stringify(next.config) === JSON.stringify(runtime.config)) return;
      const warnings = await runtime.applyConfig(next.config, { persist: false });
      logger.info(`配置已重新加载（${reason}）`);
      if (next.persisted) logger.info("迁移后的配置已写回");
      for (const warning of [...next.warnings, ...warnings]) logger.warn(warning);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("配置热加载失败，继续使用当前配置", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      reloading = false;
    }
  };

  const watchDisabled =
    process.env.SWITCHYARD_CONFIG_WATCH === "0" || process.env.SWITCHYARD_CONFIG_WATCH === "false";
  let watcher: FSWatcher | null = null;
  if (!watchDisabled) {
    try {
      watcher = watch(dirname(configPath), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== basename(configPath)) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          void reloadConfig("文件变更");
        }, 250);
        reloadTimer.unref();
      });
      watcher.on("error", (error) => logger.warn("配置文件监听中断", { error: error.message }));
    } catch (error) {
      logger.warn("无法监听配置文件变更，热加载已关闭", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stopWatch = (): void => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    watcher?.close();
    watcher = null;
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      logger.warn(`${signal} 重复到达，立即退出`);
      await logger.flush();
      process.exit(1);
    }
    closing = true;
    stopWatch();
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
  // POSIX：kill -HUP 重新读取配置（Windows 上没有 SIGHUP，用文件监听代替）
  process.on("SIGHUP", () => void reloadConfig("SIGHUP"));
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
