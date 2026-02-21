import pino from "pino";
import { BotConfig } from "./config";

let _logger: pino.Logger | null = null;

export function createLogger(config: BotConfig): pino.Logger {
  _logger = pino({
    level: config.logLevel,
    base: { service: "cetus-rebalance-bot" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: "info", base: { service: "cetus-rebalance-bot" } });
  }
  return _logger;
}
