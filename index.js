const fs = require("fs");
const http = require("http");
const https = require("https");
const { app, BASE_PATH } = require("./app");
const logger = require("./config/logger");
const flow = require("./services/flow");
const db = require("./services/db");
const { listProducts } = require("./config/products");
const recovery = require("./services/recovery");
const { serverCertificate } = require("./services/tls");

const PORT = parseInt(process.env.PORT, 10) || 3040;

// HTTPS with the shared server certificate (SSL_KEY_PATH / SSL_CERT_PATH), plain HTTP when not configured (local dev).
// SSL_CHAIN_PATH (optional): intermediate certificate(s), sent after the server certificate so clients can verify the
// full chain (cert/server.crt holds only the *.sifytechnologies.com certificate).
const { SSL_KEY_PATH, SSL_CERT_PATH, SSL_CHAIN_PATH } = process.env;
const server =
  SSL_KEY_PATH && SSL_CERT_PATH
    ? https.createServer({ key: fs.readFileSync(SSL_KEY_PATH), cert: serverCertificate(SSL_CERT_PATH, SSL_CHAIN_PATH) }, app)
    : http.createServer(app);

server.listen(PORT, () => {
  const products = listProducts().map((p) => `${p.productCode}${p.enabled ? "" : " (disabled)"}`).join(", ");
  const message = `Startup | opportunity service listening on ${SSL_KEY_PATH ? "https" : "http"} port ${PORT}, base path ${BASE_PATH}, products: ${products}`;
  console.log(message);
  logger.info(message);
  // work a stopped process left unfinished (restart / crash) is resumed once at startup (services/recovery.js)
  recovery.resumeInterrupted().catch((err) => logger.error(`Recovery | failed: ${(err && err.message) || err}`));
});

// graceful shutdown (pm2 restart / reload): stop taking requests, let running Oracle flows finish, close the DB
const shutdown = (signal) => {
  logger.info(`Shutdown | ${signal} received, waiting for running flows`);
  server.close(async () => {
    await Promise.race([flow.settled(), new Promise((resolve) => setTimeout(resolve, 60000))]);
    await db.close().catch(() => {});
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
