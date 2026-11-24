// Copy into a product service (e.g. crossconnect-domestic/services/opportunityClient.js).
// Env in the product service:
//   OPPORTUNITY_SERVICE_URL = https://localhost:<port>/onesify/opportunity/api/v1/opportunity
//                             (or ${APP_PATH}/onesify/opportunity/api/v1/opportunity through the gateway)
//   OPPORTUNITY_SERVICE_KEY = this product's key from the opportunity service SERVICE_API_KEYS
//   OPPORTUNITY_PRODUCT_CODE = CCD / CCC / ...
const axios = require("axios");
const https = require("https");

const agent = new https.Agent({ rejectUnauthorized: false }); // shared self-signed cert on the OneSify server

const client = () =>
  axios.create({
    baseURL: process.env.OPPORTUNITY_SERVICE_URL,
    headers: { "x-api-key": process.env.OPPORTUNITY_SERVICE_KEY, "Content-Type": "application/json" },
    httpsAgent: agent,
    timeout: 30000,
    maxBodyLength: 30 * 1024 * 1024,
  });

const productCode = () => process.env.OPPORTUNITY_PRODUCT_CODE;

// request = { reqId, customer, contact, lines, contractPeriod | contractYears, requestCreatedDate } (see README)
exports.create = (request) => client().post("/create", { productCode: productCode(), ...request }).then((r) => r.data);

// attachment = { base64 } (signed PDF) or { url } (host must be in the service's ALLOWED_DOCUMENT_HOSTS)
exports.orderPlaced = (reqId, attachment) =>
  client().post("/order-placed", { productCode: productCode(), reqId: String(reqId), ...(attachment ? { attachment } : {}) }).then((r) => r.data);

exports.status = (reqId) => client().get(`/${productCode()}/${encodeURIComponent(reqId)}`).then((r) => r.data);

exports.retry = (reqId) => client().post("/retry", { productCode: productCode(), reqId: String(reqId) }).then((r) => r.data);

exports.drop = (reqId, requestStatus) =>
  client()
    .post("/drop", { productCode: productCode(), reqId: String(reqId), requestStatus }, { validateStatus: (s) => s < 500 || s === 502 })
    .then((r) => r.data);

exports.dropCandidates = (includeDropped = false) =>
  client().get(`/drop-candidates/${productCode()}`, { params: { includeDropped } }).then((r) => r.data);
