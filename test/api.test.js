const { state, reset, calls, ok, oracleError, timeout, PDF, createBody, logs } = require("./helpers");
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment");
const { app, BASE_PATH } = require("../app");
const flow = require("../services/flow");
const S = require("../services/status");

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}${BASE_PATH}/opportunity`;
});
after(() => server.close());
beforeEach(() => {
  reset();
  logs.length = 0;
});

const call = async (method, path, body, key = "ccd-key") => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const record = (reqId = "20000") => state.opportunities.docs.find((d) => d.productCode === "CCD" && d.reqId === reqId);
const events = () => state.callbacks.map((c) => c.body.event);

describe("auth", () => {
  test("no key -> 401, wrong key -> 401", async () => {
    assert.equal((await call("POST", "/create", createBody(), null)).status, 401);
    assert.equal((await call("POST", "/create", createBody(), "nope")).status, 401);
  });
  test("a product key cannot act on another product -> 403", async () => {
    const res = await call("POST", "/create", createBody(), "ccc-key");
    assert.equal(res.status, 403);
    assert.equal((await call("GET", "/CCD/20000", null, "ccc-key")).status, 403);
  });
});

describe("create", () => {
  test("invalid request -> 400 before any Oracle call", async () => {
    const res = await call("POST", "/create", createBody({ customer: { oscPartyNo: "1" } }));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /customer.oscPartyId is required/);
    const bad = await call("POST", "/create", createBody({ lines: [{ productGroup: "Copper", quantity: 1, totalArc: 1, totalOtc: 1 }] }));
    assert.equal(bad.status, 400);
    assert.equal(state.oracleCalls.length, 0);
  });

  test("disabled product -> 400", async () => {
    const res = await call("POST", "/create", createBody({ productCode: "CCC" }), "ccc-key");
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not enabled/);
  });

  test("202, then stage 1 + 2 in the background; callbacks and created mail; stages 3-7 wait for order placed", async () => {
    const res = await call("POST", "/create", createBody());
    assert.equal(res.status, 202);
    await flow.settled();

    assert.deepEqual(state.oracleCalls.map((c) => c.name), ["accountTeam", "contact", "opportunity", "salesOrder"]);
    const opportunity = calls("opportunity")[0].data;
    assert.equal(opportunity.Name, "OSP_crossconnect_20000");
    assert.equal(opportunity.OwnerResourcePartyId, "300000625001288");
    assert.equal(opportunity.TargetPartyId, "300000619458508");
    assert.equal(opportunity.KeyContactId, "300000677528520");
    assert.equal(opportunity.EffectiveDate, moment(new Date("2026-10-20T05:00:00.000Z")).format("YYYY-MM-DD"));
    assert.equal(calls("contact")[0].data.AccountPartyId, "300000619458508");

    const doc = record();
    assert.equal(doc.opportunityId, "300000999000111");
    assert.equal(doc.opportunityNumber, "OPP-5001");
    assert.equal(doc.orderHeaderId, "300000888000111");
    assert.equal(doc.salesOrderStatus, S.CREATED);
    assert.equal(doc.flowLockOwner, undefined, "flow lock released");

    assert.deepEqual(events(), ["opportunity.created", "salesOrder.created"]);
    assert.equal(state.callbacks[0].url, "https://ccd.test/callback");
    assert.equal(state.callbacks[0].headers.Authorization, "Bearer cb-token");
    assert.equal(state.callbacks[0].body.opportunityNumber, "OPP-5001");
    assert.equal(state.mails.length, 1);
    assert.match(state.mails[0].subject, /^CCD opportunity and sales order created/);
    assert.deepEqual(state.mails[0].to, ["ops@example.com"]);

    const status = await call("GET", "/CCD/20000");
    assert.equal(status.status, 200);
    assert.equal(status.body.data.orderHeaderId, "300000888000111");
    assert.equal(status.body.data.orderPlaced, false);
  });

  test("create again for the same request -> no second opportunity in Oracle", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    await call("POST", "/create", createBody());
    await flow.settled();
    assert.equal(calls("opportunity").length, 1);
    assert.equal(calls("salesOrder").length, 1);
  });

  test("Oracle 4xx on the opportunity: retried, lock released, one failure mail + failed callback, payload kept", async () => {
    state.oracle.opportunity = () => oracleError(400, { detail: "bad" });
    await call("POST", "/create", createBody());
    await flow.settled();
    assert.equal(calls("opportunity").length, 3);
    assert.equal(calls("contact").length, 1, "contact created once and reused on retries");
    const doc = record();
    assert.equal(doc.opportunityStatus, undefined);
    assert.equal(doc.opportunityError.api, "opportunity");
    assert.equal(state.mails.length, 1);
    assert.match(state.mails[0].subject, /CCD opportunity creation failed/);
    assert.deepEqual(events(), ["failed"]);
  });

  test("timeout on the opportunity POST: next attempt finds it in Oracle and saves it, never posts twice", async () => {
    state.oracle.opportunity = () => timeout();
    state.oracle.findOpportunity = () => ok({ items: [{ OptyId: 555, OptyNumber: "OPP-555", Name: "OSP_crossconnect_20000" }] });
    await call("POST", "/create", createBody());
    await flow.settled();
    assert.equal(calls("opportunity").length, 1);
    assert.equal(calls("findOpportunity").length, 1);
    assert.equal(record().opportunityNumber, "OPP-555");
    assert.equal(calls("salesOrder").length, 1);
  });

  test("same contact (name, mobile, email) on another request of the account -> reused, not created again", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    state.oracle.opportunity = () => ok({ OptyId: 2, OptyNumber: "OPP-2" });
    await call("POST", "/create", createBody({ reqId: "20001", contact: { firstName: " asha ", lastName: "k", mobile: "+91 98765 43210", email: "asha@example.com" } }));
    await flow.settled();
    assert.equal(calls("contact").length, 1);
    assert.equal(record("20001").keyContactStatus, S.KEY_CONTACT_EXISTING);
    assert.equal(record("20001").keyContactReusedFrom, "CCD/20000");
  });
});

describe("order placed", () => {
  test("with a Base64 signed document: stages 3-7, document attached then removed, completed callback + mail", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    const res = await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { base64: PDF.toString("base64") } });
    assert.equal(res.status, 202);
    assert.equal(res.body.data.started, true);
    await flow.settled();

    assert.deepEqual(
      state.oracleCalls.map((c) => c.name).slice(4),
      ["approval", "submission", "poReceived", "attachment", "orderToErp"]
    );
    const attachment = calls("attachment")[0];
    assert.match(attachment.url, /opportunities\/OPP-5001\/child\/Attachment$/);
    assert.equal(attachment.data.FileName, "CCD-SO-20000.pdf");
    assert.equal(Buffer.from(attachment.data.FileContents, "base64").toString(), PDF.toString());
    const doc = record();
    assert.equal(doc.orderToErpStatus, S.SENT_TO_ERP);
    assert.equal(doc.attachmentStatus, S.UPLOADED);
    assert.equal(state.documents.docs.length, 0, "Base64 copy removed once attached");
    assert.equal(events().at(-1), "flow.completed");
    assert.match(state.mails.at(-1).subject, /CCD opportunity creation successful/);
  });

  test("order placed before the opportunity exists: flag kept, stages 3-7 run right after create", async () => {
    const res = await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { base64: PDF.toString("base64") } });
    assert.equal(res.body.data.started, false);
    await call("POST", "/create", createBody());
    await flow.settled();
    assert.equal(record().orderToErpStatus, S.SENT_TO_ERP);
    assert.equal(calls("opportunity").length, 1);
  });

  test("signed document by URL: only allowed hosts", async () => {
    const bad = await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { url: "https://evil.test/x.pdf" } });
    assert.equal(bad.status, 400);
    await call("POST", "/create", createBody());
    await flow.settled();
    await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { url: "https://docs.test/onesify/docusign/api/v1/view/signed-file/CCD-SO-20000" } });
    await flow.settled();
    assert.equal(calls("signedFile").length, 1);
    assert.equal(record().orderToErpStatus, S.SENT_TO_ERP);
  });

  test("no signed document: stage 6 fails with a mail; order-placed again with the document finishes the flow", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000" });
    await flow.settled();
    assert.equal(record().poReceivedStatus, S.RECEIVED);
    assert.equal(record().attachmentStatus, undefined);
    assert.match(state.mails.at(-1).subject, /PO document upload failed/);
    assert.equal(events().at(-1), "failed");

    await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { base64: PDF.toString("base64") } });
    await flow.settled();
    assert.equal(record().orderToErpStatus, S.SENT_TO_ERP);
    assert.equal(calls("approval").length, 1, "done stages are not repeated");
  });

  test("two triggers at once run the stages once (flow lock)", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    await call("POST", "/order-placed", { productCode: "CCD", reqId: "20000", attachment: { base64: PDF.toString("base64") } });
    await call("POST", "/retry", { productCode: "CCD", reqId: "20000" });
    await flow.settled();
    assert.equal(calls("approval").length, 1);
    assert.equal(calls("attachment").length, 1);
    assert.equal(calls("orderToErp").length, 1);
  });

  test("two runs started at the same moment: the second only asks the first to run again", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    record().orderPlaced = true;
    state.documents.docs.push({ productCode: "CCD", reqId: "20000", contentBase64: PDF.toString("base64") });
    const product = require("../config/products").getProductConfig("CCD");
    flow.startFlow(product, "20000");
    flow.startFlow(product, "20000");
    await flow.settled();
    assert.ok(logs.some((l) => /another run is active/.test(l.message)));
    assert.equal(calls("approval").length, 1);
    assert.equal(calls("orderToErp").length, 1);
    assert.equal(record().flowLockOwner, undefined);
    assert.equal(record().flowRerun, undefined);
  });
});

describe("drop", () => {
  const oldOpportunity = async ({ orderPlaced = false } = {}) => {
    await call("POST", "/create", createBody());
    await flow.settled();
    Object.assign(record(), { opportunityCreatedDate: moment().subtract(100, "days").format("YYYY-MM-DD") });
    if (orderPlaced) record().orderPlaced = true;
  };

  test("candidates list, then quote cancelled + opportunity dropped, dropped callback + mail", async () => {
    await oldOpportunity();
    const candidates = await call("GET", "/drop-candidates/CCD");
    assert.deepEqual(candidates.body.data.candidates.map((c) => c.reqId), ["20000"]);

    const res = await call("POST", "/drop", { productCode: "CCD", reqId: "20000", requestStatus: "Draft" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.result, "dropped");
    assert.deepEqual(state.oracleCalls.map((c) => c.name).slice(-2), ["quoteCancel", "opportunityDrop"]);
    assert.equal(record().opportunityDropStatus, S.DROPPED);
    assert.equal(events().at(-1), "dropped");
    assert.match(state.mails.at(-1).subject, /CCD opportunity dropped/);

    assert.equal((await call("POST", "/drop", { productCode: "CCD", reqId: "20000" })).body.data.result, "already_dropped");
    assert.equal((await call("GET", "/drop-candidates/CCD")).body.data.candidates.length, 0);
  });

  test("not dropped when too recent or the order is placed", async () => {
    await call("POST", "/create", createBody());
    await flow.settled();
    const recent = await call("POST", "/drop", { productCode: "CCD", reqId: "20000" });
    assert.equal(recent.status, 409);
    assert.match(recent.body.message, /not more than 90 days ago/);
    record().opportunityCreatedDate = moment().subtract(100, "days").format("YYYY-MM-DD");
    record().orderPlaced = true;
    const placed = await call("POST", "/drop", { productCode: "CCD", reqId: "20000" });
    assert.match(placed.body.message, /order already placed/);
    assert.equal(calls("quoteCancel").length, 0);
  });
});

describe("save (reconcile)", () => {
  test("saves ids found in Oracle; a different opportunityId -> 409", async () => {
    const res = await call("POST", "/save", { productCode: "CCD", reqId: "30000", opportunityId: "1", opportunityNumber: "OPP-1" });
    assert.equal(res.status, 200);
    assert.equal(record("30000").opportunityStatus, S.CREATED);
    const conflict = await call("POST", "/save", { productCode: "CCD", reqId: "30000", opportunityId: "2", opportunityNumber: "OPP-2" });
    assert.equal(conflict.status, 409);
  });
});
