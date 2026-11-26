// Certificate checks of calls between OneSify services, with a real TLS server and axios (no stubs).
// Fixtures (test/fixtures/tls, a throwaway CA): root -> intermediate -> *.onesify.test, like the OneSify servers:
// Sectigo root (in Node's roots) -> Sectigo intermediate -> *.sifytechnologies.com, served on https://localhost:<port>.
process.env.NODE_ENV = "test";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const https = require("https");
const os = require("os");
const axios = require("axios");
const { httpsAgent, serverCertificate } = require("../services/tls");

const dir = path.join(__dirname, "fixtures", "tls");
const file = (name) => path.join(dir, name);

// TLS_CA_FILE as on the server: the CA certificates Node does not have (here root + intermediate; on the server the
// Sectigo intermediate alone, its root being in Node's roots already)
const caBundle = path.join(os.tmpdir(), `opportunity-tls-ca-${process.pid}.pem`);
fs.writeFileSync(caBundle, `${fs.readFileSync(file("root.crt"), "utf8")}\n${fs.readFileSync(file("intermediate.crt"), "utf8")}`);
const rootOnly = path.join(os.tmpdir(), `opportunity-tls-root-${process.pid}.pem`);
fs.writeFileSync(rootOnly, fs.readFileSync(file("root.crt"), "utf8"));

const listen = (cert) =>
  new Promise((resolve) => {
    const server = https.createServer({ key: fs.readFileSync(file("server.key")), cert }, (req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const get = (server, agent) => axios.get(`https://localhost:${server.address().port}/`, { httpsAgent: agent, timeout: 5000 }).then((r) => r.data);
const failure = (promise) => promise.then(() => null, (e) => e.code);

after(() => {
  fs.rmSync(caBundle, { force: true });
  fs.rmSync(rootOnly, { force: true });
});
beforeEach(() => {
  delete process.env.TLS_CA_FILE;
});

describe("server sends only its own certificate (like crossconnect-domestic: cert/server.crt)", () => {
  let server;
  before(async () => {
    server = await listen(serverCertificate(file("server.crt")));
  });
  after(() => server.close());

  test("verified with TLS_CA_FILE (intermediate) + servername", async () => {
    process.env.TLS_CA_FILE = caBundle;
    assert.equal(await get(server, httpsAgent("demo.onesify.test")), "ok");
  });
  test("refused without servername: localhost is not in the certificate", async () => {
    process.env.TLS_CA_FILE = caBundle;
    assert.equal(await failure(get(server, httpsAgent())), "ERR_TLS_CERT_ALTNAME_INVALID");
  });
  test("refused when the intermediate is missing", async () => {
    process.env.TLS_CA_FILE = rootOnly;
    assert.equal(await failure(get(server, httpsAgent("demo.onesify.test"))), "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });
  test("refused with Node's roots only (certificate is never accepted unverified)", async () => {
    assert.equal(await failure(get(server, httpsAgent("demo.onesify.test"))), "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });
});

describe("server sends its chain (this service with SSL_CHAIN_PATH)", () => {
  let server;
  before(async () => {
    server = await listen(serverCertificate(file("server.crt"), file("intermediate.crt")));
  });
  after(() => server.close());

  test("verified with the root alone: the client needs no intermediate", async () => {
    process.env.TLS_CA_FILE = rootOnly;
    assert.equal(await get(server, httpsAgent("demo.onesify.test")), "ok");
  });
});
