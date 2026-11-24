const axios = require("axios");
const logger = require("../config/logger");
const { httpError, clean } = require("./util");

// request / response body for the logs: JSON, Base64 file contents replaced by their length, capped at 20000 chars
const LOG_BODY_MAX = 20000;
const logBody = (body) => {
  if (body === undefined) return "-";
  let text;
  if (Buffer.isBuffer(body)) {
    text = `<binary, ${body.length} bytes>`;
  } else if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body, (key, value) =>
        (key === "FileContents" || key === "base64") && typeof value === "string" ? `<Base64, ${value.length} chars>` : value);
    } catch (e) {
      text = String(body);
    }
  }
  return text.length > LOG_BODY_MAX ? `${text.slice(0, LOG_BODY_MAX)}... (${text.length} chars, truncated)` : text;
};

// calls Oracle CRM (Basic auth, credentials from env)
// Oracle 401/403 -> 502 (our credentials); other 4xx -> 422 (rejected, do not retry); 5xx / network -> 502
// error.rejected = Oracle answered with a 4xx, i.e. nothing was created
// path: relative to OPPORTUNITY_BASE_URL, or a full URL (stage 6 attachment, OPPORTUNITY_ATTACHMENT_URL)
// ctx { label, tag }: every request and response / error is logged under that label; credentials are never logged
const callOracle = async (method, path, payload, ctx = {}) => {
  const { OPPORTUNITY_BASE_URL, OPPORTUNITY_USERNAME, OPPORTUNITY_PASSWORD } = process.env;
  const fullUrl = /^https?:\/\//i.test(path);
  if ((!fullUrl && !OPPORTUNITY_BASE_URL) || !OPPORTUNITY_USERNAME || !OPPORTUNITY_PASSWORD) {
    throw httpError(500, "Oracle API URL/credentials not configured", { rejected: true });
  }
  const url = fullUrl ? path : `${OPPORTUNITY_BASE_URL}${path}`;
  const log = `${ctx.label || "oracle_api"} -- ${ctx.tag || "-"}`;
  const started = Date.now();
  logger.info(`${log} -- Oracle request: ${method.toUpperCase()} ${url}${payload !== undefined ? ` -- payload: ${logBody(payload)}` : ""}`);
  try {
    const { data, status } = await axios.request({
      method,
      url,
      data: payload,
      auth: { username: OPPORTUNITY_USERNAME, password: OPPORTUNITY_PASSWORD },
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });
    logger.info(`${log} -- Oracle response: HTTP ${status || "-"} (${Date.now() - started} ms) -- body: ${logBody(data)}`);
    return data;
  } catch (error) {
    const oracleStatus = error.response ? error.response.status : undefined;
    logger.error(`${log} -- Oracle error: ${oracleStatus ? `HTTP ${oracleStatus}` : error.code || "NO_RESPONSE"} (${Date.now() - started} ms) -- ${error.response ? `body: ${logBody(error.response.data)}` : error.message}`);
    const rejected = oracleStatus >= 400 && oracleStatus < 500;
    if (oracleStatus === 401 || oracleStatus === 403) {
      throw httpError(502, `Oracle API: ${oracleStatus} authentication/authorization failed`, { rejected });
    }
    const body = error.response && error.response.data;
    const detail = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : error.message;
    throw httpError(rejected ? 422 : 502, `Oracle API: ${oracleStatus || error.code || "NO_RESPONSE"} ${clean(detail).slice(0, 500)}`, { rejected });
  }
};

module.exports = { callOracle, logBody };
