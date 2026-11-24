const logger = require("../config/logger");
const { getCollections } = require("./db");
const S = require("./status");
const { httpError, clean, now } = require("./util");

let indexed = false;

// index creation must not block the API; the code checks (productCode, reqId) explicitly as well
const getCollection = async () => {
  const { opportunities } = await getCollections();
  if (!indexed) {
    indexed = true;
    try {
      await opportunities.createIndex({ productCode: 1, reqId: 1 }, { unique: true });
      // sparse: records without an opportunityId yet (create in progress) don't clash
      await opportunities.createIndex({ opportunityId: 1 }, { unique: true, sparse: true });
      await opportunities.createIndex({ ebsAccountNo: 1 });
    } catch (err) {
      logger.error(`opportunities -- index setup failed: ${err.message}`);
    }
  }
  return opportunities;
};

const getDocuments = async () => (await getCollections()).documents;

const keyOf = (product, reqId) => ({ productCode: product.productCode, reqId });

// public view of a record (status endpoint / callbacks)
const opportunityData = (doc) => {
  const data = {
    productCode: doc.productCode,
    reqId: doc.reqId,
    opportunityId: doc.opportunityId,
    opportunityNumber: doc.opportunityNumber,
    KeyContactId: doc.KeyContactId,
  };
  if (doc.orderHeaderId) data.orderHeaderId = doc.orderHeaderId;
  return data;
};

// step statuses for GET /opportunity/:productCode/:reqId
const statusView = (doc) => ({
  ...opportunityData(doc),
  opportunityStatus: doc.opportunityStatus || null,
  salesOrderStatus: doc.salesOrderStatus || null,
  orderPlaced: !!doc.orderPlaced,
  approvalStatus: doc.approvalStatus || null,
  proposalSubmissionStatus: doc.proposalSubmissionStatus || null,
  poReceivedStatus: doc.poReceivedStatus || null,
  attachmentStatus: doc.attachmentStatus || null,
  attachmentDocumentId: doc.attachmentDocumentId || null,
  orderToErpStatus: doc.orderToErpStatus || null,
  quoteCancelStatus: doc.quoteCancelStatus || null,
  opportunityDropStatus: doc.opportunityDropStatus || null,
  opportunityError: doc.opportunityError ? { api: doc.opportunityError.api, message: doc.opportunityError.message, date: doc.opportunityError.date } : null,
  flowRunning: !!(doc.flowLockUntil && new Date(doc.flowLockUntil) > new Date()),
  createdDate: doc.createdDate,
  updatedDate: doc.updatedDate,
});

// records (or reconciles) the opportunity ids of a request; never replaces a different opportunityId already stored
const saveOpportunity = async (collection, key, data) => {
  const opportunityId = clean(data.opportunityId);
  const opportunityNumber = clean(data.opportunityNumber);
  if (!opportunityId || !opportunityNumber) {
    throw httpError(400, "opportunityId and opportunityNumber are required");
  }
  const existing = await collection.findOne(key);
  if (existing && existing.opportunityId && existing.opportunityId !== opportunityId) {
    throw httpError(409, `${key.productCode}/${key.reqId} already has a different opportunityId`);
  }
  const orderHeaderId = clean(data.orderHeaderId);
  if (orderHeaderId && existing && existing.orderHeaderId && existing.orderHeaderId !== orderHeaderId) {
    throw httpError(409, `${key.productCode}/${key.reqId} already has a different orderHeaderId`);
  }
  const fields = {};
  for (const name of ["OwnerResourcePartyId", "KeyContactId", "EffectiveDate", "ebsAccountNo", "companyName", "oscpartyId", "opportunityPayload"]) {
    if (data[name] !== undefined && data[name] !== null && data[name] !== "") fields[name] = data[name];
  }
  const unset = { attemptedDate: "", opportunityError: "" };
  // reconciling a sales order that exists in Oracle but was not saved
  if (orderHeaderId) {
    Object.assign(fields, { orderHeaderId, salesOrderStatus: S.CREATED });
    unset.salesOrderAttemptedDate = "";
  }
  // stage 6 reconciliation: attachmentDocumentId = attached in Oracle; retryAttachment = not attached, may upload again
  const attachmentDocumentId = clean(data.attachmentDocumentId);
  if (attachmentDocumentId) {
    Object.assign(fields, { attachmentDocumentId, attachmentStatus: S.UPLOADED, attachmentDate: now() });
    unset.attachmentAttemptedDate = "";
  } else if (data.retryAttachment === true && existing && existing.attachmentStatus !== S.UPLOADED) {
    unset.attachmentStatus = "";
    unset.attachmentAttemptedDate = "";
  }
  const time = now();
  // first save of the opportunity ids: start of the drop period
  if (!existing || !existing.opportunityId) fields.opportunityCreatedDate = time;
  try {
    const result = await collection.updateOne(
      { ...key, $or: [{ opportunityId: { $exists: false } }, { opportunityId }] },
      {
        $set: { ...fields, ...key, opportunityId, opportunityNumber, opportunityStatus: S.CREATED, updatedDate: time },
        $unset: unset,
        $setOnInsert: { createdDate: time },
      },
      { upsert: true }
    );
    return { created: !existing || !existing.opportunityId, matched: result.matchedCount + (result.upsertedCount || 0) };
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(409, "reqId or opportunityId already exists with a different value");
    }
    throw err;
  }
};

// tests reset the index flag between in-memory databases
const resetIndexes = () => {
  indexed = false;
};

module.exports = { getCollection, getDocuments, keyOf, opportunityData, statusView, saveOpportunity, resetIndexes };
