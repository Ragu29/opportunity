// shared test setup: silent logger, in-memory MongoDB fake, stubbed Oracle / callbacks / mail. Nothing external is touched.
process.env.NODE_ENV = "test";
const Module = require("module");

// silent logger (lines collected so tests can check them)
const logs = [];
const loggerPath = require.resolve("../config/logger");
const loggerModule = new Module(loggerPath);
loggerModule.filename = loggerPath;
loggerModule.loaded = true;
loggerModule.exports = {
  info: (m) => logs.push({ level: "info", message: String(m) }),
  error: (m) => logs.push({ level: "error", message: String(m) }),
  warn: (m) => logs.push({ level: "warn", message: String(m) }),
};
require.cache[loggerPath] = loggerModule;

const axios = require("axios");
const mailer = require("../services/mailer");
const db = require("../services/db");
const store = require("../services/store");

// ---------- in-memory MongoDB fake (subset used by the service) ----------
const isOperatorObject = (cond) =>
  cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).some((k) => k.startsWith("$"));
const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);
const lt = (a, b) => (typeof a === "string" ? a < b : cmp(a, b) < 0);

const matches = (doc, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    const value = doc[key];
    if (isOperatorObject(cond)) {
      if ("$exists" in cond && (value !== undefined) !== cond.$exists) return false;
      if ("$nin" in cond && cond.$nin.includes(value)) return false;
      if ("$ne" in cond && value === cond.$ne) return false;
      if ("$lt" in cond && !(value !== undefined && lt(value, cond.$lt))) return false;
      if ("$gte" in cond && !(value !== undefined && !lt(value, cond.$gte))) return false;
      return true;
    }
    return value === cond;
  });

class FakeCollection {
  constructor(docs = [], uniqueKeys = []) {
    this.docs = docs;
    this.uniqueKeys = uniqueKeys; // e.g. ["productCode", "reqId"]
    this.failUpdate = null; // (filter, update) => Error | null
  }
  async findOne(filter) {
    const doc = this.docs.find((d) => matches(d, filter));
    return doc ? structuredClone(doc) : null;
  }
  find(filter) {
    const found = this.docs.filter((d) => matches(d, filter)).map((d) => structuredClone(d));
    return { toArray: async () => found };
  }
  async updateOne(filter, update, options = {}) {
    const failure = this.failUpdate && this.failUpdate(filter, update);
    if (failure) throw failure;
    let doc = this.docs.find((d) => matches(d, filter));
    let upserted = 0;
    if (!doc) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const seed = Object.fromEntries(Object.entries(filter).filter(([k, v]) => !k.startsWith("$") && !isOperatorObject(v)));
      const merged = { ...seed, ...(update.$set || {}) };
      if (this.uniqueKeys.length && this.docs.some((d) => this.uniqueKeys.every((k) => d[k] === merged[k]))) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      }
      doc = { ...seed, ...(update.$setOnInsert || {}) };
      this.docs.push(doc);
      upserted = 1;
    }
    Object.assign(doc, structuredClone(update.$set || {}));
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    for (const [key, value] of Object.entries(update.$push || {})) doc[key] = [...(doc[key] || []), structuredClone(value)];
    return { matchedCount: upserted ? 0 : 1, modifiedCount: upserted ? 0 : 1, upsertedCount: upserted };
  }
  async deleteOne(filter) {
    const index = this.docs.findIndex((d) => matches(d, filter));
    if (index >= 0) this.docs.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  }
  async createIndex() {}
}

// ---------- stubbed Oracle (routed by method + URL) ----------
const ok = (data) => Promise.resolve({ data, status: 200 });
const oracleError = (status, data) => Promise.reject(Object.assign(new Error(`status ${status}`), { response: { status, data } }));
const timeout = () => Promise.reject(Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" }));

const defaultOracle = () => ({
  accountTeam: () => ok({ items: [{ ResourceId: 111, OwnerFlag: false }, { ResourceId: 300000625001288, OwnerFlag: true }] }),
  contact: () => ok({ PartyId: 300000677528520 }),
  opportunity: () => ok({ OptyId: 300000999000111, OptyNumber: "OPP-5001" }),
  salesOrder: () => ok({ OrderHeaderId: 300000888000111 }),
  approval: () => ok({ Status: "Proposal Approved" }),
  submission: () => ok({ SalesStageId: 300000677571123 }),
  poReceived: () => ok({ SalesStageId: 300000677571124 }),
  attachment: () => ok({ AttachedDocumentId: 300000777000999 }),
  orderToErp: () => ok({ Status: "Order To ERP" }),
  quoteCancel: () => ok({ Status: "Cancelled" }),
  opportunityDrop: () => ok({ StatusCode: "DROPPED" }),
  findOpportunity: () => ok({ items: [] }),
  findSalesOrder: () => ok({ items: [] }),
  findAttachment: () => ok({ items: [] }),
  signedFile: () => ok(Buffer.from("%PDF-1.4 downloaded signed order")),
});

const route = (config) => {
  const { method, url, data } = config;
  const m = method.toLowerCase();
  if (url.includes("/AccountTeam")) return "accountTeam";
  if (url.includes("/contacts")) return "contact";
  if (url.includes("/child/Attachment")) return m === "get" ? "findAttachment" : "attachment";
  if (url.includes("/signed-file/")) return "signedFile";
  if (url.includes("/salesOrders")) {
    if (m === "post") return "salesOrder";
    if (m === "get") return "findSalesOrder";
    return { "Proposal Approved": "approval", "Order To ERP": "orderToErp", Cancelled: "quoteCancel" }[data && data.Status];
  }
  if (url.includes("/opportunities")) {
    if (m === "post") return "opportunity";
    if (m === "get") return "findOpportunity";
    if (data && data.StatusCode === "DROPPED") return "opportunityDrop";
    return data && data.SalesStageId === "300000677571123" ? "submission" : "poReceived";
  }
  return null;
};

const state = { oracle: null, oracleCalls: [], callbacks: [], mails: [], opportunities: null, documents: null };

const reset = () => {
  Object.assign(process.env, {
    OPPORTUNITY_BASE_URL: "https://oracle.test",
    OPPORTUNITY_ATTACHMENT_URL: "https://oracle.test/salesApi/resources/11.12.1.0/opportunities",
    OPPORTUNITY_USERNAME: "user",
    OPPORTUNITY_PASSWORD: "secret",
    OPPORTUNITY_RETRY_ATTEMPTS: "3",
    OPPORTUNITY_RETRY_DELAY_MS: "0",
    SERVICE_API_KEYS: "CCD:ccd-key,CCC:ccc-key",
    CALLBACK_URL_CCD: "https://ccd.test/callback",
    CALLBACK_TOKEN: "cb-token",
    MAIL_RECIPIENTS_CCD: "ops@example.com",
    ALLOWED_DOCUMENT_HOSTS: "docs.test",
  });
  state.oracle = defaultOracle();
  state.oracleCalls = [];
  state.callbacks = [];
  state.mails = [];
  state.opportunities = new FakeCollection([], ["productCode", "reqId"]);
  state.documents = new FakeCollection([], ["productCode", "reqId"]);
  db.setCollections({ opportunities: state.opportunities, documents: state.documents });
  store.resetIndexes();
};

axios.request = (config) => {
  const name = route(config);
  state.oracleCalls.push({ name, method: config.method.toLowerCase(), url: config.url, data: config.data });
  if (!name || !state.oracle[name]) return Promise.reject(new Error(`unexpected call ${config.method} ${config.url}`));
  return state.oracle[name](config);
};
axios.post = (url, body, options) => {
  state.callbacks.push({ url, body, headers: options && options.headers });
  return ok({ status: "Success" });
};
mailer.sendMail = async (mail) => {
  state.mails.push(mail);
  return { success: true, messageId: "test" };
};

const calls = (name) => state.oracleCalls.filter((c) => c.name === name);

const PDF = Buffer.from("%PDF-1.4 signed order 20000");

// a CCD /opportunity/create body, as crossconnect-domestic builds it from its quote
const createBody = (overrides = {}) => ({
  productCode: "CCD",
  reqId: "20000",
  customer: { oscPartyNo: "2016", oscPartyId: "300000619458508", ebsAccountNo: "EBS1", companyName: "Acme" },
  contact: { firstName: "Asha", lastName: "K", mobile: "9876543210", email: "Asha@Example.com" },
  lines: [{ productGroup: "Fiber", quantity: 1, totalArc: 2000, totalOtc: 500 }],
  contractPeriod: "1 Year",
  requestCreatedDate: "2026-10-20T05:00:00.000Z",
  ...overrides,
});

module.exports = { logs, state, reset, calls, ok, oracleError, timeout, FakeCollection, PDF, createBody };
