const fs = require("fs");
const https = require("https");
const tls = require("tls");
const { clean } = require("./util");

// HTTPS agent for calls to other OneSify services (product callbacks, signed document download).
// The server certificate is always verified. Two optional settings make that work on the OneSify servers:
//   TLS_CA_FILE - PEM file with extra CA certificates, added to Node's built-in roots. Needed when a server sends only
//                 its own certificate without the intermediate (the product services serve cert/server.crt alone, so
//                 the Sectigo intermediate must be supplied here).
//   servername  - the name the certificate is checked against when the URL uses localhost or an IP
//                 (e.g. onesifydemo.sifytechnologies.com for https://localhost:4027, matching *.sifytechnologies.com).
const agents = new Map();

const httpsAgent = (servername) => {
  const name = clean(servername);
  const caFile = clean(process.env.TLS_CA_FILE);
  const cacheKey = `${name}|${caFile}`;
  if (!agents.has(cacheKey)) {
    const options = { rejectUnauthorized: true };
    if (caFile) options.ca = [...tls.rootCertificates, fs.readFileSync(caFile, "utf8")];
    if (name) options.servername = name;
    agents.set(cacheKey, new https.Agent(options));
  }
  return agents.get(cacheKey);
};

// certificate this service serves: SSL_CERT_PATH, followed by the intermediate(s) in SSL_CHAIN_PATH when set, so clients
// can verify the full chain (cert/server.crt holds only the *.sifytechnologies.com certificate)
const serverCertificate = (certPath, chainPath) =>
  clean(chainPath)
    ? `${fs.readFileSync(certPath, "utf8").trim()}\n${fs.readFileSync(chainPath, "utf8").trim()}\n`
    : fs.readFileSync(certPath);

module.exports = { httpsAgent, serverCertificate };
