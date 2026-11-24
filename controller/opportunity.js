const logger = require("../config/logger");
const { getProductConfig, listProducts } = require("../config/products");
const flow = require("../services/flow");
const drop = require("../services/drop");
const store = require("../services/store");
const documents = require("../services/documents");
const { httpError, toReqId, tagOf } = require("../services/util");

// known errors (statusCode) are answered directly; anything else goes to the error handler
const sendError = (req, res, next, e) => {
  logger.error(`${req.method} ${req.originalUrl} -- Error: ${e.message || e}`);
  if (e.statusCode) {
    return res.status(e.statusCode).send({ status: "Error", ...(e.code ? { code: e.code } : {}), message: e.message });
  }
  next(e);
};

// product + reqId of a request (body or URL params); 400 when either is missing / invalid
const target = (source) => {
  const product = getProductConfig(source.productCode);
  const reqId = toReqId(source.reqId);
  if (reqId === null) throw httpError(400, "reqId is required (letters, digits, - or _, max 64)");
  return { product, reqId, tag: tagOf(product.productCode, reqId) };
};

// POST /opportunity/create
// body { productCode, reqId, customer, contact, lines, contractPeriod | contractYears, requestCreatedDate }
// answers 202 straight away; stage 1 (with retries) and stage 2 run in the background (results by callback / status)
exports.create = async (req, res, next) => {
  try {
    const { product, reqId, tag } = target(req.body || {});
    const request = flow.normalizeRequest(product, req.body);
    await flow.acceptCreate(product, reqId, request);
    flow.startCreate(product, reqId);
    logger.info(`create_opportunity -- ${tag} -- accepted, running in background`);
    return res.status(202).send({ status: "Success", message: "Opportunity creation started", data: { productCode: product.productCode, reqId } });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// POST /opportunity/order-placed  body { productCode, reqId, attachment?: { base64 } | { url } }
// saves orderPlaced and starts stages 3-7 (after stage 2 when needed); sending it again re-runs what is still missing
exports.orderPlaced = async (req, res, next) => {
  try {
    const { product, reqId, tag } = target(req.body || {});
    const attachment = documents.parseAttachment(req.body.attachment);
    const result = await flow.orderPlaced(product, reqId, attachment);
    logger.info(`order_placed -- ${tag} -- ${result.message}`);
    return res.status(202).send({ status: "Success", message: result.message, data: { productCode: product.productCode, reqId, started: result.started } });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// POST /opportunity/retry  body { productCode, reqId }: runs again whatever is missing (stage 1 when no opportunity yet,
// else stages 2-7) - e.g. after a failure mail once the cause is fixed
exports.retry = async (req, res, next) => {
  try {
    const { product, reqId, tag } = target(req.body || {});
    const doc = await (await store.getCollection()).findOne(store.keyOf(product, reqId));
    if (!doc) throw httpError(404, `No opportunity record for ${tag}`);
    if (doc.opportunityId) flow.startFlow(product, reqId);
    else if (doc.request) flow.startCreate(product, reqId);
    else throw httpError(400, `No request data saved for ${tag}; send /opportunity/create`);
    logger.info(`retry -- ${tag} -- started ${doc.opportunityId ? "stages 2-7" : "stage 1"}`);
    return res.status(202).send({ status: "Success", message: `Retry started (${doc.opportunityId ? "stages 2-7" : "opportunity creation"})` });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// GET /opportunity/:productCode/:reqId: ids + status of every step
exports.status = async (req, res, next) => {
  try {
    const { product, reqId, tag } = target(req.params);
    const doc = await (await store.getCollection()).findOne(store.keyOf(product, reqId));
    if (!doc) throw httpError(404, `No opportunity record for ${tag}`);
    return res.status(200).send({ status: "Success", data: store.statusView(doc) });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// POST /opportunity/save: reconcile ids that exist in Oracle but were not saved
// body { productCode, reqId, opportunityId, opportunityNumber, orderHeaderId?, attachmentDocumentId?, retryAttachment? }
exports.save = async (req, res, next) => {
  try {
    const { product, reqId, tag } = target(req.body || {});
    const collection = await store.getCollection();
    const saved = await store.saveOpportunity(collection, store.keyOf(product, reqId), req.body);
    logger.info(`save_opportunity -- ${tag} -- opportunityId: ${req.body.opportunityId} -- ${saved.created ? "saved" : "updated"}`);
    return res.status(200).send({ status: "Success", message: saved.created ? "Opportunity saved" : "Opportunity updated" });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// POST /opportunity/drop  body { productCode, reqId, requestStatus? }
exports.drop = async (req, res, next) => {
  try {
    const { product, reqId } = target(req.body || {});
    const result = await drop.dropRequest(product, reqId, { requestStatus: req.body.requestStatus });
    const messages = {
      dropped: result.quoteCancelled ? "Quote cancelled and opportunity dropped" : "Opportunity dropped (no quote created)",
      already_dropped: "Opportunity already dropped",
      skipped: `Not dropped: ${result.reason}`,
      failed: `Drop failed at ${result.step} level: ${result.error}`,
    };
    const statusCode = result.result === "failed" ? 502 : result.result === "skipped" ? 409 : 200;
    return res.status(statusCode).send({ status: statusCode === 200 ? "Success" : "Error", message: messages[result.result], data: result });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// GET /opportunity/drop-candidates/:productCode?includeDropped=true
exports.dropCandidates = async (req, res, next) => {
  try {
    const product = getProductConfig(req.params.productCode);
    const includeDropped = req.query.includeDropped === "true";
    const data = await drop.dropCandidates(product, { includeDropped });
    return res.status(200).send({ status: "Success", data });
  } catch (e) {
    sendError(req, res, next, e);
  }
};

// GET /opportunity/products
exports.products = (req, res) => res.status(200).send({ status: "Success", data: listProducts() });
