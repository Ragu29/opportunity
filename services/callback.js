const axios = require("axios");
const https = require("https");
const logger = require("../config/logger");
const { clean, wait } = require("./util");
const { retryAttempts, retryDelayMs } = require("./retry");

// events sent to the product (its URL comes from config, never from a request), so it can save the Oracle ids on its
// own request: opportunity.created, salesOrder.created, flow.completed, failed, dropped.
// Best effort: retried, then only logged - the product can always read GET /opportunity/:productCode/:reqId.
const agent = new https.Agent({ rejectUnauthorized: false });

const callbackUrl = (product) => clean(product.callbackUrlEnv && process.env[product.callbackUrlEnv]);

const sendCallback = async (product, event, doc, extra = {}) => {
  const url = callbackUrl(product);
  if (!url) return;
  const body = {
    event,
    productCode: product.productCode,
    reqId: doc.reqId,
    opportunityId: doc.opportunityId || null,
    opportunityNumber: doc.opportunityNumber || null,
    orderHeaderId: doc.orderHeaderId || null,
    ...extra,
    at: new Date().toISOString(),
  };
  const token = clean(process.env.CALLBACK_TOKEN);
  const tag = `${product.productCode}/${doc.reqId}`;
  const attempts = retryAttempts();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await axios.post(url, body, {
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        httpsAgent: agent,
        timeout: 15000,
      });
      logger.info(`callback -- ${tag} -- ${event} sent to ${url}`);
      return;
    } catch (e) {
      logger.error(`callback -- ${tag} -- ${event} attempt ${attempt}/${attempts} failed: ${(e.response && `HTTP ${e.response.status}`) || e.code || e.message}`);
      if (attempt < attempts) await wait(retryDelayMs() * attempt);
    }
  }
};

module.exports = { sendCallback, callbackUrl };
