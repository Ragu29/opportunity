// Shared by migrate-ccd.js (crossconnect-domestic ccd_opportunity -> this service) and export-ccd.js (back, for a
// rollback to the in-process flow). Both record shapes are the same (field names, status values, "YYYY-MM-DD" dates);
// only the key differs: CCD { reqId: Number }, this service { productCode: "CCD", reqId: String }.
//
// Copy rules (safe to run any number of times, in either direction):
//   - target record missing           -> inserted
//   - target record exists            -> only fields it does not have yet are filled in; nothing is overwritten
//     (e.g. the stub an early order-placed left behind gets the opportunity ids)
//   - different opportunityId on both -> conflict, nothing written (reconcile by hand)
//   - IN_PROGRESS create locks are written as UNKNOWN: the process that held them is stopped, and UNKNOWN makes the
//     next attempt look the record up in Oracle before posting again
require("../services/envConfig");
const { MongoClient } = require("mongodb");

const LOCK_FIELDS = ["opportunityStatus", "salesOrderStatus", "attachmentStatus"];
// fields only this service uses; never written to ccd_opportunity
const SERVICE_ONLY_FIELDS = ["productCode", "request", "createPending", "flowLockUntil", "flowLockOwner", "flowRerun", "migratedFrom", "attachmentSource", "attachmentUrl"];

const clean = (value) => (value === undefined || value === null ? "" : String(value).trim());
const validId = (value) => !!clean(value) && clean(value) !== "-";

const unlock = (record) => {
  const out = { ...record };
  for (const field of LOCK_FIELDS) if (out[field] === "IN_PROGRESS") out[field] = "UNKNOWN";
  return out;
};

// what to do with one source record -> { action: "insert" | "fill" | "same" | "conflict", set?, reason? }
const planCopy = (target, source) => {
  if (target && validId(target.opportunityId) && validId(source.opportunityId) && clean(target.opportunityId) !== clean(source.opportunityId)) {
    return { action: "conflict", reason: `opportunityId ${target.opportunityId} in target, ${source.opportunityId} in source` };
  }
  if (!target) return { action: "insert" };
  const set = {};
  for (const [field, value] of Object.entries(source)) {
    if (field !== "_id" && target[field] === undefined && value !== undefined) set[field] = value;
  }
  return Object.keys(set).length ? { action: "fill", set } : { action: "same" };
};

// work left after the copy that nothing will trigger again by itself
const pendingWork = (record) => {
  if (record.opportunityDropStatus === "DROPPED" || record.quoteCancelStatus === "CANCELLED") return null;
  if (!validId(record.opportunityId)) return "no opportunity yet: send the create again from the product";
  if (record.salesOrderStatus !== "CREATED") return "sales order not created";
  if (record.orderPlaced && record.orderToErpStatus !== "SENT") return "order placed, stages 3-7 not finished";
  return null;
};

const connect = async () => {
  const { MONGODB_CLUSTER, MONGODB_DBNAME, DB_USERNAME, DB_PASSWORD } = process.env;
  const ccdDbName = process.env.CCD_MONGODB_DBNAME || process.env.SOURCE_MONGODB_DBNAME;
  if (!MONGODB_CLUSTER || !MONGODB_DBNAME || !ccdDbName) {
    throw new Error("MONGODB_CLUSTER, MONGODB_DBNAME and SOURCE_MONGODB_DBNAME (the crossconnect-domestic DB) are required");
  }
  const client = new MongoClient(MONGODB_CLUSTER, DB_USERNAME ? { auth: { username: DB_USERNAME, password: DB_PASSWORD }, authSource: "admin" } : {});
  await client.connect();
  return {
    client,
    ccd: client.db(ccdDbName).collection("ccd_opportunity"),
    service: client.db(MONGODB_DBNAME).collection("opportunities"),
    names: { ccd: `${ccdDbName}.ccd_opportunity`, service: `${MONGODB_DBNAME}.opportunities` },
  };
};

// copies every source record with the rules above; prints one line per record and a summary
const run = async ({ apply, label, sources, targetOf, toTarget, write }) => {
  const counts = { insert: 0, fill: 0, same: 0, conflict: 0 };
  const pending = [];
  for (const source of sources) {
    const record = unlock(toTarget(source));
    const target = await targetOf(record);
    const plan = planCopy(target, record);
    counts[plan.action]++;
    const id = `CCD/${record.reqId}`;
    if (plan.action === "conflict") {
      console.log(`CONFLICT ${id} -- ${plan.reason} -- not copied, reconcile by hand`);
      continue;
    }
    if (plan.action !== "same") {
      const what = plan.action === "insert" ? "insert" : `fill ${Object.keys(plan.set).join(", ")}`;
      console.log(`${apply ? "" : "would "}${what} ${id} -- opportunity ${record.opportunityNumber || "-"} -- sales order ${record.orderHeaderId || "-"}`);
      if (apply) await write(record, plan, target);
    }
    const after = plan.action === "insert" ? record : { ...record, ...target, ...(plan.set || {}) };
    const left = pendingWork(after);
    if (left) pending.push(`${id}: ${left}`);
  }
  console.log(`${label}${apply ? "" : " (dry run, nothing written; add --apply)"}: ${sources.length} source record(s) -- insert ${counts.insert}, fill ${counts.fill}, unchanged ${counts.same}, conflict ${counts.conflict}`);
  if (pending.length) {
    console.log(`Not finished, nothing will start them by itself (${pending.length}):`);
    for (const line of pending) console.log(`  ${line}`);
  }
  return { counts, pending };
};

const main = (fn) =>
  fn().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

module.exports = { LOCK_FIELDS, SERVICE_ONLY_FIELDS, unlock, planCopy, pendingWork, connect, run, main };
