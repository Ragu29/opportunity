const logger = require("../config/logger");
const { wait } = require("./util");

// every step, DB save after an Oracle success, callback and mail gets up to OPPORTUNITY_RETRY_ATTEMPTS (default 4)
// attempts, waiting OPPORTUNITY_RETRY_DELAY_MS x attempt between them (default 5000 ms)
const retryAttempts = () => Math.max(1, parseInt(process.env.OPPORTUNITY_RETRY_ATTEMPTS, 10) || 4);
const retryDelayMs = () => {
  const ms = parseInt(process.env.OPPORTUNITY_RETRY_DELAY_MS, 10);
  return Number.isInteger(ms) && ms >= 0 ? ms : 5000;
};

// a retry cannot help: created in Oracle but not saved (reconcile via /opportunity/save), or more than one match in Oracle
const NOT_RETRIED = ["OPPORTUNITY_NOT_SAVED", "SALES_ORDER_NOT_SAVED", "ATTACHMENT_NOT_SAVED", "LOOKUP_AMBIGUOUS"];

// -> { value } on success, { skipped } when blocked by another run / awaiting reconciliation (409), else { error, attempt }
const withRetry = async (label, tag, fn, attempts = retryAttempts()) => {
  let attempt = 0;
  let error;
  while (attempt < attempts) {
    attempt++;
    try {
      const value = await fn();
      if (attempt > 1) logger.info(`${label} -- ${tag} -- succeeded on attempt ${attempt}/${attempts}`);
      return { value };
    } catch (e) {
      error = e;
      if (e.statusCode === 409) {
        logger.info(`${label} -- ${tag} -- skipped: ${e.message}`);
        return { skipped: true };
      }
      logger.error(`${label} -- ${tag} -- attempt ${attempt}/${attempts} failed: ${e.message || e}`);
      if (NOT_RETRIED.includes(e.code)) break;
      if (attempt < attempts) await wait(retryDelayMs() * attempt);
    }
  }
  return { error, attempt };
};

// DB write after an Oracle success: retried so a short DB hiccup does not leave a record created in Oracle but not saved
const retryDb = async (label, tag, fn) => {
  const attempts = retryAttempts();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      logger.error(`${label} -- ${tag} -- DB save attempt ${attempt}/${attempts} failed: ${e.message}`);
      if (attempt >= attempts) throw e;
      await wait(retryDelayMs() * attempt);
    }
  }
};

module.exports = { retryAttempts, retryDelayMs, NOT_RETRIED, withRetry, retryDb };
