const { state, reset, calls, ok, PDF, createBody, logs } = require("./helpers");
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const flow = require("../services/flow");
const recovery = require("../services/recovery");
const { getProductConfig } = require("../config/products");
const S = require("../services/status");
const { planCopy, unlock, pendingWork } = require("../scripts/ccdRecords");

const CCD = getProductConfig("CCD");
const record = (reqId = "20000") => state.opportunities.docs.find((d) => d.productCode === "CCD" && d.reqId === reqId);
const seed = (doc) => state.opportunities.docs.push({ productCode: "CCD", reqId: "20000", createdDate: "2026-11-20", ...doc });

beforeEach(() => {
  reset();
  logs.length = 0;
  delete process.env.OPPORTUNITY_RECOVER_ON_START;
});

describe("startup recovery (work a stopped process left unfinished)", () => {
  test("create stopped while the opportunity POST was running: looked up in Oracle, found -> saved, never posted again", async () => {
    seed({ request: flow.normalizeRequest(CCD, createBody()), createPending: true, opportunityStatus: S.IN_PROGRESS, attemptedDate: "2026-11-20" });
    state.oracle.findOpportunity = () => ok({ items: [{ OptyId: 555, OptyNumber: "OPP-555", Name: "OSP_crossconnect_20000" }] });
    const result = await recovery.resumeInterrupted();
    await flow.settled();
    assert.deepEqual(result.resumed, [{ tag: "CCD/20000", run: "create" }]);
    assert.equal(calls("opportunity").length, 0);
    assert.equal(record().opportunityNumber, "OPP-555");
    assert.equal(record().orderHeaderId, "300000888000111", "the flow continued with stage 2");
    assert.equal(record().createPending, undefined);
  });

  test("create accepted (202) but stopped before Oracle was called: created once", async () => {
    seed({ request: flow.normalizeRequest(CCD, createBody()), createPending: true });
    await recovery.resumeInterrupted();
    await flow.settled();
    assert.equal(calls("opportunity").length, 1);
    assert.equal(record().opportunityNumber, "OPP-5001");
  });

  test("flow stopped during the attachment upload: lock released, attachment looked up first, flow completes", async () => {
    seed({
      opportunityId: "300000999000111",
      opportunityNumber: "OPP-5001",
      opportunityStatus: S.CREATED,
      orderHeaderId: "300000888000111",
      salesOrderStatus: S.CREATED,
      orderPlaced: true,
      approvalStatus: S.APPROVED,
      proposalSubmissionStatus: S.SUBMITTED,
      poReceivedStatus: S.RECEIVED,
      attachmentStatus: S.IN_PROGRESS,
      flowLockOwner: "12345-dead",
      flowLockUntil: new Date(Date.now() + 20 * 60 * 1000),
    });
    state.documents.docs.push({ productCode: "CCD", reqId: "20000", contentBase64: PDF.toString("base64") });
    const result = await recovery.resumeInterrupted();
    await flow.settled();
    assert.deepEqual(result.resumed, [{ tag: "CCD/20000", run: "flow" }]);
    assert.deepEqual(state.oracleCalls.map((c) => c.name), ["findAttachment", "attachment", "orderToErp"]);
    assert.equal(record().orderToErpStatus, S.SENT_TO_ERP);
    assert.equal(record().flowLockOwner, undefined);
  });

  test("finished, failed and dropped records are left alone", async () => {
    seed({ reqId: "1", opportunityId: "1", opportunityNumber: "OPP-1", orderToErpStatus: S.SENT_TO_ERP });
    seed({ reqId: "2", request: flow.normalizeRequest(CCD, createBody({ reqId: "2" })), opportunityError: { message: "failed" } });
    seed({ reqId: "3", opportunityId: "3", opportunityNumber: "OPP-3", opportunityDropStatus: S.DROPPED, flowLockOwner: "dead" });
    const result = await recovery.resumeInterrupted();
    await flow.settled();
    assert.deepEqual(result.resumed, []);
    assert.equal(state.oracleCalls.length, 0);
  });

  test("OPPORTUNITY_RECOVER_ON_START=false: nothing touched", async () => {
    process.env.OPPORTUNITY_RECOVER_ON_START = "false";
    seed({ request: flow.normalizeRequest(CCD, createBody()), createPending: true, opportunityStatus: S.IN_PROGRESS });
    const result = await recovery.resumeInterrupted();
    assert.equal(result.skipped, true);
    assert.equal(record().opportunityStatus, S.IN_PROGRESS);
  });
});

describe("CCD record copy rules (migrate-ccd.js / export-ccd.js)", () => {
  test("missing target -> insert; IN_PROGRESS locks are copied as UNKNOWN", () => {
    const source = unlock({ reqId: 1, opportunityStatus: S.IN_PROGRESS, salesOrderStatus: S.IN_PROGRESS, attachmentStatus: S.UPLOADED });
    assert.equal(source.opportunityStatus, S.UNKNOWN);
    assert.equal(source.salesOrderStatus, S.UNKNOWN);
    assert.equal(source.attachmentStatus, S.UPLOADED);
    assert.equal(planCopy(null, source).action, "insert");
  });

  test("existing target -> only missing fields filled in, nothing overwritten", () => {
    const target = { reqId: 1, orderPlaced: true, attachmentStatus: S.UNKNOWN };
    const source = { reqId: 1, opportunityId: "9", opportunityNumber: "OPP-9", attachmentStatus: S.UPLOADED, orderPlaced: false };
    const plan = planCopy(target, source);
    assert.equal(plan.action, "fill");
    assert.deepEqual(plan.set, { opportunityId: "9", opportunityNumber: "OPP-9" });
    assert.equal(planCopy({ ...target, ...plan.set }, source).action, "same", "running it again changes nothing");
  });

  test("different opportunityId on both sides -> conflict, nothing written", () => {
    assert.equal(planCopy({ opportunityId: "1" }, { opportunityId: "2" }).action, "conflict");
  });

  test("work nothing will start by itself is listed", () => {
    assert.match(pendingWork({}), /no opportunity yet/);
    assert.match(pendingWork({ opportunityId: "1", salesOrderStatus: S.UNKNOWN }), /sales order not created/);
    assert.match(pendingWork({ opportunityId: "1", salesOrderStatus: S.CREATED, orderPlaced: true, attachmentStatus: S.UNKNOWN }), /stages 3-7/);
    assert.equal(pendingWork({ opportunityId: "1", salesOrderStatus: S.CREATED }), null, "waiting for order placed: started by it");
    assert.equal(pendingWork({ opportunityId: "1", salesOrderStatus: S.CREATED, orderPlaced: true, orderToErpStatus: S.SENT_TO_ERP }), null);
    assert.equal(pendingWork({ opportunityId: "1", opportunityDropStatus: S.DROPPED }), null);
  });
});
