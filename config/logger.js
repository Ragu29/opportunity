const { createLogger, format, transports } = require("winston");
const appRoot = require("app-root-path");
const logContext = require("../services/logContext");

// one readable line per entry: 2026-11-24 10:14:02 | INFO  | reqId CCD/20000 | message
const addReqId = format((info) => {
  if (!info.reqId) info.reqId = logContext.reqId();
  return info;
});

const line = format.printf((info) =>
  [info.timestamp, info.level.toUpperCase().padEnd(5), info.reqId ? `reqId ${info.reqId}` : "-", info.stack || info.message].join(" | ")
);

const logFormat = format.combine(format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), format.errors({ stack: true }), addReqId(), line);

const logTransports = [
  new transports.File({
    filename: `${appRoot}/logs/onesify_opportunity_api_activity.log`,
    level: "info",
    // rotation: 20 MB per file, last 10 files kept
    maxsize: 20 * 1024 * 1024,
    maxFiles: 10,
    tailable: true,
  }),
];
if (process.env.NODE_ENV === "dev") logTransports.push(new transports.Console());

module.exports = createLogger({ format: logFormat, transports: logTransports });
