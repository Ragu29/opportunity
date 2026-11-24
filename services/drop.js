const moment = require("moment");
const logger = require("../config/logger");
const P = require("./payloadBuilder");
const osc = require("./oscApi");
const { callOracle } = require("./oscClient");
const store = require("./store");
const notify = require("./notify");
const { sendCallback } = require("./callback");
const S = require("./status");
const { httpError, clean, validId, now, tagOf } = require("./util");
const { withRetry, retryDb } = require("./retry");

// Drop a stale request in Oracle CRM. The PRODUCT decides a request is stale (its own status, e.g. CCD: Draft /
// Awaiting Signature) and calls POST /opportunity/drop; this service only checks what it knows itself (opportunity age,
// order not placed, nothing in progress), then:
//   1. quote level (only when a sales order exists): PATCH salesOrders/{orderHeaderId} { Status: "Cancelled" }
//   2. line item level, after step 1:                 PATCH opportunities/{no} { StatusCode: "DROPPED", reason }
// The product hides its own request afterwards (CCD: quoteccds.isActive false) when it gets dropped / already_dropped.

const dropCutoff = (product) => moment().subtract(product.drop.afterDays, "days").format("YYYY-MM-DD");
const createdOn = (doc) => clean(doc.opportunityCreatedDate || doc.createdDate);
const flowRunning = (doc) => !!(doc.flowLockUntil && new Date(doc.flowLockUntil) > new Date());

// why a request must not be dropped (null = drop it)
const dropBlocker = (product, doc) => {
  if (!doc || !validId(doc.opportunityNumber)) return "no opportunity number saved";
  if (doc.orderPlaced) return "order already placed";
  const created = createdOn(doc);
  if (!moment(created, "YYYY-MM-DD", true).isValid()) return `opportunity created date unknown (${created || "-"})`;
  if (created >= dropCutoff(product)) return `opportunity created ${created}, not more than ${product.drop.afterDays} days ago`;
  if ([S.IN_PROGRESS, S.UNKNOWN].includes(doc.salesOrderStatus)) {
    return `sales order creation ${doc.salesOrderStatus === S.UNKNOWN ? "outcome unknown" : "in progress"}, reconcile it first`;
  }
  if (flowRunning(doc)) return "opportunity flow (stages 2-7) is running";
  return null;
};

const cancelQuote = async (collection, doc) => {
  if (doc.quoteCancelStatus === S.CANCELLED) return;
  const tag = tagOf(doc.productCode, doc.reqId);
  if (!validId(doc.orderHeaderId)) throw httpError(400, `No orderHeaderId saved for ${tag}`);
  const payload = P.buildQuoteCancelPayload();
  const data = await callOracle("patch", osc.salesOrderPath(doc.orderHeaderId), payload, { label: "drop_quote", tag });
  if (data && typeof data === "object" && data.Status !== undefined && data.Status !== P.QUOTE_CANCELLED_STATUS) {
    throw httpError(502, `Sales order cancel returned Status: ${data.Status}`);
  }
  await retryDb("drop_quote", tag, async () => {
    const saved = await collection.updateOne(
      { productCode: doc.productCode, reqId: doc.reqId, orderHeaderId: doc.orderHeaderId },
      { $set: { quoteCancelStatus: S.CANCELLED, quoteCancelPayload: payload, quoteCancelledDate: now(), updatedDate: now() } }
    );
    if (!saved.matchedCount) throw new Error("no opportunity record matched");
  });
};

const dropOpportunityLine = async (collection, product, doc) => {
  if (doc.opportunityDropStatus === S.DROPPED) return;
  const tag = tagOf(doc.productCode, doc.reqId);
  if (validId(doc.orderHeaderId) && doc.quoteCancelStatus !== S.CANCELLED) {
    throw httpError(400, `Quote (orderHeaderId ${doc.orderHeaderId}) not cancelled yet for ${tag}`);
  }
  const payload = P.buildOpportunityDropPayload(product);
  const data = await callOracle("patch", osc.opportunityDropPath(doc.opportunityNumber), payload, { label: "drop_opportunity", tag });
  if (data && typeof data === "object" && data.StatusCode !== undefined && data.StatusCode !== P.OPPORTUNITY_DROPPED_STATUS) {
    throw httpError(502, `Opportunity drop returned StatusCode: ${data.StatusCode}`);
  }
  await retryDb("drop_opportunity", tag, async () => {
    const saved = await collection.updateOne(
      { productCode: doc.productCode, reqId: doc.reqId, opportunityNumber: doc.opportunityNumber },
      { $set: { opportunityDropStatus: S.DROPPED, opportunityDropPayload: payload, opportunityDroppedDate: now(), updatedDate: now() } }
    );
    if (!saved.matchedCount) throw new Error("no opportunity record matched");
  });
};

// -> { reqId, result: "dropped" | "already_dropped" | "skipped" | "failed", ... }; one attempt per step (the product
// calls again on its next run)
const dropRequest = async (product, reqId, { requestStatus } = {}) => {
  const tag = tagOf(product.productCode, reqId);
  const key = store.keyOf(product, reqId);
  const collection = await store.getCollection();
  let doc = await collection.findOne(key);
  const base = { productCode: product.productCode, reqId, opportunityNumber: (doc && doc.opportunityNumber) || undefined, orderHeaderId: (doc && doc.orderHeaderId) || undefined };
  if (doc && doc.opportunityDropStatus === S.DROPPED) {
    return { ...base, result: "already_dropped", opportunityDroppedDate: doc.opportunityDroppedDate };
  }
  const reason = dropBlocker(product, doc);
  if (reason) {
    logger.info(`drop_opportunity -- ${tag} -- not dropped: ${reason}`);
    return { ...base, result: "skipped", reason };
  }
  const load = async () => {
    doc = await collection.findOne(key);
  };
  const failed = async (label, stage, step, outcome) => {
    const message = (outcome.error && outcome.error.message) || String(outcome.error);
    await notify.sendFailureMail(product, doc, message, outcome.attempt, { stage, doc }).catch((err) => logger.error(`${label} -- ${tag} -- error mail failed: ${err.message}`));
    return { ...base, result: "failed", step, error: message };
  };
  const withQuote = validId(doc.orderHeaderId);
  if (withQuote) {
    const step = await withRetry("drop_quote", tag, async () => { await load(); await cancelQuote(collection, doc); }, 1);
    if (step.error) return failed("drop_quote", "quoteCancel", "quote", step);
  }
  const line = await withRetry("drop_opportunity", tag, async () => { await load(); await dropOpportunityLine(collection, product, doc); }, 1);
  if (line.error) return failed("drop_opportunity", "opportunityDrop", "opportunity", line);
  await load();
  logger.info(`drop_opportunity -- ${tag} -- DROPPED -- opportunityNumber: ${doc.opportunityNumber}${withQuote ? ` -- orderHeaderId ${doc.orderHeaderId} cancelled` : ""}`);
  await notify.sendDroppedMail(product, doc, requestStatus).catch((err) => logger.error(`drop_opportunity -- ${tag} -- dropped mail failed: ${err.message}`));
  await sendCallback(product, "dropped", doc);
  return { ...base, result: "dropped", quoteCancelled: withQuote, opportunityDropped: true };
};

// requests of a product whose opportunity is older than the drop period (and not dropped, unless includeDropped):
// the product checks its own status for each and calls /opportunity/drop
const dropCandidates = async (product, { includeDropped = false } = {}) => {
  const collection = await store.getCollection();
  const cutoff = dropCutoff(product);
  const filter = {
    productCode: product.productCode,
    opportunityNumber: { $exists: true },
    $or: [{ opportunityCreatedDate: { $lt: cutoff } }, { opportunityCreatedDate: { $exists: false }, createdDate: { $lt: cutoff } }],
  };
  if (!includeDropped) filter.opportunityDropStatus = { $exists: false };
  const docs = await collection.find(filter).toArray();
  return {
    cutoff,
    days: product.drop.afterDays,
    candidates: docs
      .map((d) => ({
        reqId: d.reqId,
        opportunityNumber: d.opportunityNumber,
        opportunityCreatedDate: createdOn(d),
        orderPlaced: !!d.orderPlaced,
        dropped: d.opportunityDropStatus === S.DROPPED,
      }))
      .sort((a, b) => String(a.reqId).localeCompare(String(b.reqId), undefined, { numeric: true })),
  };
};

module.exports = { dropRequest, dropCandidates, dropBlocker };
