const logger = require("../config/logger");
const { getProductConfig } = require("../config/products");
const store = require("./store");
const flow = require("./flow");
const S = require("./status");
const { now, tagOf } = require("./util");

// Resumes work a stopped process left unfinished. Background runs live in memory, so a restart (pm2 restart, deploy,
// crash) drops them. Runs once at startup, when - with one instance (ecosystem.config.js: instances 1) - every lock
// still held belongs to a process that is gone:
//   - IN_PROGRESS create locks (opportunity / sales order / attachment) become UNKNOWN, so the next attempt looks the
//     record up in Oracle before posting again: nothing is created twice
//   - flow leases are released
// then creates that were accepted but never finished (createPending) and interrupted flows are started again.
// OPPORTUNITY_RECOVER_ON_START=false turns it off (required if the service ever runs as several instances).
const LOCK_FIELDS = ["opportunityStatus", "salesOrderStatus", "attachmentStatus"];

const resumeInterrupted = async () => {
  if (process.env.OPPORTUNITY_RECOVER_ON_START === "false") {
    logger.info("Recovery | OPPORTUNITY_RECOVER_ON_START=false, skipped");
    return { skipped: true, resumed: [] };
  }
  const collection = await store.getCollection();
  const docs = await collection
    .find({
      $or: [{ createPending: true }, { flowLockOwner: { $exists: true } }, ...LOCK_FIELDS.map((field) => ({ [field]: S.IN_PROGRESS }))],
    })
    .toArray();
  const resumed = [];
  for (const doc of docs) {
    const tag = tagOf(doc.productCode, doc.reqId);
    try {
      const set = {};
      const unset = {};
      for (const field of LOCK_FIELDS) {
        if (doc[field] === S.IN_PROGRESS && !(field === "opportunityStatus" && doc.opportunityId)) set[field] = S.UNKNOWN;
      }
      if (doc.flowLockOwner) Object.assign(unset, { flowLockUntil: "", flowLockOwner: "", flowRerun: "" });
      if (Object.keys(set).length || Object.keys(unset).length) {
        await collection.updateOne(
          { productCode: doc.productCode, reqId: doc.reqId },
          { $set: { ...set, updatedDate: now() }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
        );
        logger.info(`Recovery | ${tag} -- left by a stopped process: ${[...Object.keys(set).map((f) => `${f} ${S.IN_PROGRESS} -> ${S.UNKNOWN}`), ...(doc.flowLockOwner ? ["flow lock released"] : [])].join(", ")}`);
      }
      let product;
      try {
        product = getProductConfig(doc.productCode);
      } catch (e) {
        logger.error(`Recovery | ${tag} -- not resumed: ${e.message}`);
        continue;
      }
      if (doc.opportunityDropStatus === S.DROPPED || doc.quoteCancelStatus === S.CANCELLED) continue;
      if (!doc.opportunityId) {
        if (!doc.request) continue;
        flow.startCreate(product, doc.reqId);
        resumed.push({ tag, run: "create" });
      } else {
        flow.startFlow(product, doc.reqId);
        resumed.push({ tag, run: "flow" });
      }
    } catch (err) {
      logger.error(`Recovery | ${tag} -- failed: ${err.message}`);
    }
  }
  logger.info(`Recovery | ${docs.length} record(s) left unfinished, resumed: ${resumed.map((r) => `${r.tag} (${r.run})`).join(", ") || "none"}`);
  return { skipped: false, resumed };
};

module.exports = { resumeInterrupted };
