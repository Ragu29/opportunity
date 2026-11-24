require("./services/envConfig");
const express = require("express");
const logger = require("./config/logger");
const logContext = require("./services/logContext");
const { clean, tagOf } = require("./services/util");

const BASE_PATH = clean(process.env.BASE_PATH) || "/onesify/opportunity/api/v1";

const app = express();
app.disable("x-powered-by");
// signed documents (Base64 PDF) come with /order-placed
app.use(express.json({ limit: "25mb" }));

// every log line of a request carries "PRODUCT/reqId"; one line per request with status and duration
app.use((req, res, next) => {
  const source = { ...(req.body || {}) };
  const parts = req.path.split("/").filter(Boolean);
  const productCode = clean(source.productCode).toUpperCase();
  const tag = productCode && clean(source.reqId) ? tagOf(productCode, clean(source.reqId)) : parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
  const started = Date.now();
  res.on("finish", () => logger.info(`${req.method} ${req.originalUrl} -- HTTP ${res.statusCode} (${Date.now() - started} ms)`));
  logContext.run({ reqId: tag }, () => next());
});

app.get(`${BASE_PATH}/health`, (req, res) => res.status(200).send({ status: "Success", message: "ok" }));
app.use(`${BASE_PATH}/opportunity`, require("./route/opportunity"));

app.use((req, res) => res.status(404).send({ status: "Error", message: `Not found: ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).send({ status: "Error", message: "Invalid JSON body" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).send({ status: "Error", message: "Request body too large" });
  }
  logger.error(`${req.method} ${req.originalUrl} -- unexpected error: ${(err && err.stack) || err}`);
  res.status(500).send({ status: "Error", message: "Internal server error" });
});

module.exports = { app, BASE_PATH };
