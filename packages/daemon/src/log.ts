import pino from "pino";

// Human-oriented lines to stderr (stdout stays clean for prompts/UX).
export const log = pino(
  {
    level: process.env.CCSHARE_LOG_LEVEL ?? "info",
    base: undefined,
    timestamp: false,
  },
  pino.destination(2),
);
