const crypto = require("crypto");
const logger = require("../config/logger");
const P = require("./payloadBuilder");
const osc = require("./oscApi");
const { callOracle, logBody } = require("./oscClient");
const store = require("./store");
const documents = require("./documents");
const notify = require("./notify");
const { sendCallback } = require("./callback");
const logContext = require("./logContext");
const S = require("./status");
const { httpError, clean, validId, now, wait, tagOf } = require("./util");
const { withRetry, retryDb, retryAttempts, retryDelayMs, NOT_RETRIED } = require("./retry");

// Opportunity flow for one request of one product (record key: productCode + reqId)
//   stage 1   AccountTeam owner -> contact (KeyContactId) -> opportunity            (POST /opportunity/create)
//   stage 2   sales order "In Progress"                                             (right after stage 1)
//   stage 3-7 Proposal Approved -> proposal submitted -> PO received -> signed document -> Order To ERP
//             (only once the product reports the order placed: POST /opportunity/order-placed)
// Every Oracle create is locked (IN_PROGRESS / UNKNOWN / CREATED) so a retry never creates a second record; an unknown
// outcome is looked up in Oracle before posting again. Stages 2-7 of a request run under a MongoDB lease lock
// (flowLockUntil / flowLockOwner), so only one run is active per request even with several instances (pm2 cluster).

// ---------- request data sent by the product ----------

// validates the /opportunity/create body -> request data stored on the record (400 on anything invalid, before any
// Oracle call). The product resolves its own data (quote, company, user) into this shape.
const normalizeRequest = (product, body) => {
  const customer = body.customer || {};
  const contact = body.contact || {};
  const contract = {};
  if (clean(body.contractPeriod)) contract.contractPeriod = clean(body.contractPeriod);
  if (clean(body.contractYears) !== "") contract.contractYears = Number(body.contractYears);
  const request = {
    customer: {
      oscPartyNo: clean(customer.oscPartyNo),
      oscPartyId: clean(customer.oscPartyId),
      ebsAccountNo: clean(customer.ebsAccountNo),
      companyName: clean(customer.companyName),
    },
    contact: {
      firstName: clean(contact.firstName),
      lastName: clean(contact.lastName),
      mobile: clean(contact.mobile),
      email: clean(contact.email),
    },
    lines: (Array.isArray(body.lines) ? body.lines : []).map((line) => ({
      productGroup: clean(line && line.productGroup),
      quantity: line && line.quantity,
      totalArc: line && line.totalArc,
      totalOtc: line && line.totalOtc,
    })),
    contract,
    requestCreatedDate: body.requestCreatedDate,
  };
  for (const [name, value] of Object.entries({
    "customer.oscPartyNo": request.customer.oscPartyNo,
    "customer.oscPartyId": request.customer.oscPartyId,
    "customer.ebsAccountNo": request.customer.ebsAccountNo,
  })) {
    if (!validId(value)) throw httpError(400, `${name} is required`);
  }
  if (!request.contact.firstName || !request.contact.email) {
    throw httpError(400, "contact.firstName and contact.email are required");
  }
  P.effectiveDate(request.requestCreatedDate);
  request.requestCreatedDate = new Date(request.requestCreatedDate).toISOString();
  P.buildChildRevenue(product, request.lines, request.contract);
  return request;
};

// stores the request data on the record (only while no opportunity exists yet; afterwards the saved data is kept)
const acceptCreate = async (product, reqId, request) => {
  const collection = await store.getCollection();
  const key = store.keyOf(product, reqId);
  const time = now();
  try {
    await collection.updateOne(
      { ...key, opportunityId: { $exists: false } },
      { $set: { ...key, request, ebsAccountNo: request.customer.ebsAccountNo, companyName: request.customer.companyName, updatedDate: time }, $setOnInsert: { createdDate: time } },
      { upsert: true }
    );
  } catch (e) {
    if (e.code !== 11000) throw e; // opportunity already created for this request: keep its data
  }
};

// ---------- stage 1: contact + opportunity ----------

// contact compared to find an existing KeyContactId: name, mobile (last 10 digits) and email, case / spaces ignored
const contactName = (value) => clean(value).replace(/\s+/g, " ").toLowerCase();
const contactMobile = (value) => clean(value).replace(/\D/g, "").slice(-10);
const sameContactData = (detail, payload) =>
  !!detail &&
  validId(detail.KeyContactId) &&
  contactName(detail.FirstName) === contactName(payload.FirstName) &&
  contactName(detail.LastName) === contactName(payload.LastName) &&
  clean(detail.EmailAddress).toLowerCase() === clean(payload.EmailAddress).toLowerCase() &&
  contactMobile(detail.MobileNumber) === contactMobile(payload.MobileNumber);

// existing KeyContactId of the same Oracle account (ebsAccountNo, any product) with the same contact data
const findExistingContact = async (collection, ebsAccountNo, contactPayload) => {
  const docs = await collection.find({ ebsAccountNo, KeyContactId: { $exists: true } }).toArray();
  return (
    docs
      .sort((a, b) => clean(a.createdDate).localeCompare(clean(b.createdDate)) || String(a.reqId).localeCompare(String(b.reqId), undefined, { numeric: true }))
      .map((doc) => ({ doc, detail: (doc.contactDetails || []).find((c) => sameContactData(c, contactPayload)) }))
      .find((match) => match.detail) || null
  );
};

// KeyContactId: the one saved for this request (retry), an existing contact with the same data, or a new Oracle contact
// (saved straight away so a retry never creates a second contact)
const getContactId = async (collection, product, key, request, tag) => {
  const existing = await collection.findOne(key);
  if (existing && validId(existing.KeyContactId)) {
    logger.info(`create_opportunity -- ${tag} -- KeyContactId: ${existing.KeyContactId} -- reused (saved for this request)`);
    return existing.KeyContactId;
  }
  const contactPayload = P.buildContactPayload(product, { contact: request.contact, accountPartyId: request.customer.oscPartyId });
  const email = contactPayload.EmailAddress.toLowerCase();
  const existingContact = await findExistingContact(collection, request.customer.ebsAccountNo, contactPayload);
  let contactId = existingContact && clean(existingContact.detail.KeyContactId);
  if (!contactId) {
    logger.info(`create_opportunity -- ${tag} -- no existing contact with the same name, mobile and email, creating a new KeyContact in Oracle`);
    let data;
    try {
      data = await callOracle("post", osc.CONTACT_PATH, contactPayload, { label: "create_contact", tag });
    } catch (e) {
      e.failedRequest = { api: "contact", payload: contactPayload };
      throw e;
    }
    if (!data || !validId(data.PartyId)) {
      throw httpError(502, "Contact API did not return PartyId");
    }
    contactId = clean(data.PartyId);
    logger.info(`create_opportunity -- ${tag} -- KeyContactId: ${contactId} -- created in Oracle`);
  } else {
    logger.info(`create_opportunity -- ${tag} -- KeyContactId: ${contactId} -- ${S.KEY_CONTACT_EXISTING} (from ${existingContact.doc.productCode}/${existingContact.doc.reqId}), no new contact created`);
  }
  const contactDetail = existingContact ? existingContact.detail : { ...contactPayload, KeyContactId: contactId, createdDate: now() };
  const set = {
    ebsAccountNo: request.customer.ebsAccountNo,
    KeyContactId: contactId,
    contactEmail: email,
    keyContactStatus: existingContact ? S.KEY_CONTACT_EXISTING : S.KEY_CONTACT_CREATED,
    updatedDate: now(),
  };
  if (existingContact) set.keyContactReusedFrom = `${existingContact.doc.productCode}/${existingContact.doc.reqId}`;
  await collection.updateOne(key, { $set: set, $push: { contactDetails: contactDetail } });
  return contactId;
};

const success = (message, data) => ({ status: "Success", message, data });

const blockedResponse = (product, doc) => {
  const unknown = doc.opportunityStatus === S.UNKNOWN;
  const message = unknown
    ? `Previous opportunity creation for ${tagOf(doc.productCode, doc.reqId)} did not complete and may already exist in Oracle CRM (Name ${P.opportunityName(product, doc.reqId)}). Reconcile it via /opportunity/save.`
    : `Opportunity creation for ${tagOf(doc.productCode, doc.reqId)} is already in progress or awaiting reconciliation.`;
  return { status: "Error", code: unknown ? "OPPORTUNITY_OUTCOME_UNKNOWN" : "OPPORTUNITY_IN_PROGRESS", message };
};

// one create attempt -> { statusCode, body, failedRequest } or { statusCode: 500, error }
const createOpportunityOnce = async (product, reqId) => {
  const key = store.keyOf(product, reqId);
  const tag = tagOf(product.productCode, reqId);
  const log = `create_opportunity -- ${tag}`;
  let collection;
  let locked = false;
  let created = null;
  try {
    collection = await store.getCollection();
    const existing = await collection.findOne(key);
    if (existing && existing.opportunityId) {
      logger.info(`${log} -- opportunity already exists -- opportunityId: ${existing.opportunityId}`);
      return { statusCode: 200, body: success("Opportunity already exists", store.opportunityData(existing)) };
    }
    if (existing && existing.opportunityStatus === S.IN_PROGRESS) {
      return { statusCode: 409, body: blockedResponse(product, existing) };
    }
    const request = existing && existing.request;
    if (!request) throw httpError(404, `No request data saved for ${tag}; send it with /opportunity/create`);
    const company = request.customer;
    const date = P.effectiveDate(request.requestCreatedDate);
    const childRevenue = P.buildChildRevenue(product, request.lines, request.contract);
    logger.info(`${log} -- attempt started -- company: ${company.companyName || "-"}, ebsAccountNo ${company.ebsAccountNo}, oscPartyNo ${company.oscPartyNo}, oscPartyId ${company.oscPartyId} -- EffectiveDate: ${date} -- ChildRevenue: ${logBody(childRevenue)}`);
    const savedFields = { EffectiveDate: date, ebsAccountNo: company.ebsAccountNo, companyName: company.companyName, oscpartyId: company.oscPartyId };

    // an earlier POST timed out / failed (5xx): ask Oracle before posting again
    if (existing.opportunityStatus === S.UNKNOWN) {
      logger.info(`${log} -- opportunityStatus ${S.UNKNOWN}: looking for ${P.opportunityName(product, reqId)} in Oracle before creating again`);
      let found;
      try {
        found = await osc.findOpportunityInOracle(product, reqId, tag);
      } catch (e) {
        throw httpError(502, `Opportunity outcome still unknown, Oracle lookup failed: ${e.message}`, {
          code: e.code === "LOOKUP_AMBIGUOUS" ? e.code : "OPPORTUNITY_OUTCOME_UNKNOWN",
        });
      }
      if (found) {
        await retryDb("create_opportunity", tag, async () => {
          const saved = await store.saveOpportunity(collection, key, { ...found, ...savedFields });
          if (!saved.matched) throw new Error("no opportunity record matched");
        });
        logger.info(`${log} -- found in Oracle (opportunityId ${found.opportunityId}), saved without creating a second one`);
        return { statusCode: 200, body: success("Opportunity found in Oracle and saved", { ...key, ...found, KeyContactId: existing.KeyContactId }) };
      }
      logger.info(`${log} -- not found in Oracle, creating it again`);
      await collection.updateOne(
        { ...key, opportunityId: { $exists: false }, opportunityStatus: S.UNKNOWN },
        { $unset: { opportunityStatus: "", attemptedDate: "" }, $set: { updatedDate: now() } }
      );
    }

    // lock: only one create per request at a time
    const time = now();
    const lock = await collection.updateOne(
      { ...key, opportunityId: { $exists: false }, opportunityStatus: { $nin: [S.IN_PROGRESS, S.UNKNOWN] } },
      { $set: { opportunityStatus: S.IN_PROGRESS, attemptedDate: time, updatedDate: time } }
    );
    locked = lock.modifiedCount === 1;
    if (!locked) {
      const current = await collection.findOne(key);
      if (current && current.opportunityId) {
        return { statusCode: 200, body: success("Opportunity already exists", store.opportunityData(current)) };
      }
      return { statusCode: 409, body: blockedResponse(product, current || { ...key, opportunityStatus: S.IN_PROGRESS }) };
    }
    logger.info(`${log} -- locked (opportunityStatus ${S.IN_PROGRESS})`);

    const ownerResourcePartyId = await osc.getOwnerResourceId(tag, company.oscPartyNo);
    const keyContactId = await getContactId(collection, product, key, request, tag);
    const payload = P.buildOpportunityPayload(product, {
      reqId,
      ownerResourcePartyId,
      targetPartyId: company.oscPartyId,
      keyContactId,
      effectiveDate: date,
      childRevenue,
    });

    let data;
    try {
      data = await callOracle("post", osc.OPPORTUNITY_PATH, payload, { label: "create_opportunity", tag });
    } catch (e) {
      if (!e.rejected) e.outcomeUnknown = true;
      e.failedRequest = { api: "opportunity", payload };
      throw e;
    }
    created = P.extractOpportunity(data);
    if (!created) {
      throw httpError(502, "Opportunity API did not return OptyId / OptyNumber", { outcomeUnknown: true });
    }
    logger.info(`${log} -- opportunityId: ${created.opportunityId} -- opportunityNumber: ${created.opportunityNumber} -- created in Oracle`);

    try {
      await retryDb("create_opportunity", tag, async () => {
        const saved = await store.saveOpportunity(collection, key, {
          ...created,
          ...savedFields,
          OwnerResourcePartyId: ownerResourcePartyId,
          KeyContactId: keyContactId,
          opportunityPayload: payload,
        });
        if (!saved.matched) throw new Error("no opportunity record matched");
      });
    } catch (e) {
      // created in Oracle but not saved: stays IN_PROGRESS (blocks re-creation); reconcile via /opportunity/save
      logger.error(`${log} -- RECONCILE: Oracle created but save failed -- opportunityId: ${created.opportunityId} -- opportunityNumber: ${created.opportunityNumber} -- KeyContactId: ${keyContactId} -- Error: ${e.message}`);
      return {
        statusCode: 500,
        body: {
          status: "Error",
          code: "OPPORTUNITY_NOT_SAVED",
          message: `Opportunity ${created.opportunityNumber} was created in Oracle CRM but could not be saved. Reconcile via /opportunity/save; do not retry.`,
          data: { ...key, ...created },
        },
      };
    }
    logger.info(`${log} -- saved: opportunityStatus ${S.CREATED}`);
    return { statusCode: 200, body: success("Opportunity created", { ...key, ...created, KeyContactId: keyContactId }) };
  } catch (e) {
    if (locked && !created) {
      // nothing created in Oracle -> release the lock; outcome unknown -> keep blocking until looked up
      const update = e.outcomeUnknown
        ? { $set: { opportunityStatus: S.UNKNOWN, updatedDate: now() } }
        : { $unset: { opportunityStatus: "", attemptedDate: "" }, $set: { updatedDate: now() } };
      await collection.updateOne({ ...key, opportunityId: { $exists: false } }, update).catch((err) =>
        logger.error(`${log} -- lock update failed: ${err.message}`)
      );
      if (e.outcomeUnknown) {
        logger.error(`${log} -- outcome unknown (${S.UNKNOWN}), the next attempt looks it up in Oracle -- ${e.message}`);
        return {
          statusCode: 502,
          body: { status: "Error", code: "OPPORTUNITY_OUTCOME_UNKNOWN", message: `${e.message} -- opportunity outcome unknown; the next attempt checks Oracle before creating again` },
          failedRequest: e.failedRequest,
        };
      }
    }
    if (e.statusCode) {
      return { statusCode: e.statusCode, body: { status: "Error", ...(e.code ? { code: e.code } : {}), message: e.message }, failedRequest: e.failedRequest };
    }
    return { statusCode: 500, error: e, failedRequest: e.failedRequest };
  }
};

const attemptError = (result) =>
  result.error ? result.error.message || String(result.error) : (result.body && result.body.message) || `HTTP ${result.statusCode}`;

const loadDoc = async (product, reqId) => (await store.getCollection()).findOne(store.keyOf(product, reqId));

// stage 1 with retries, then stages 2-7; one failure mail after the last attempt
const processOpportunity = async (product, reqId) => {
  const tag = tagOf(product.productCode, reqId);
  const attempts = retryAttempts();
  let result;
  let attempt = 0;
  while (attempt < attempts) {
    attempt++;
    result = await createOpportunityOnce(product, reqId);
    if (!result.error && result.statusCode < 400) {
      if (attempt > 1) logger.info(`create_opportunity -- ${tag} -- succeeded on attempt ${attempt}/${attempts}`);
      const doc = await loadDoc(product, reqId);
      await sendCallback(product, "opportunity.created", doc || result.body.data || { reqId });
      startFlow(product, reqId);
      return result;
    }
    // blocked by an earlier run (in progress / awaiting reconciliation): not a failure of this request
    if (!result.error && result.statusCode === 409) return result;
    logger.error(`create_opportunity -- ${tag} -- attempt ${attempt}/${attempts} failed: ${attemptError(result)}`);
    if (NOT_RETRIED.includes(result.body && result.body.code)) break;
    // a request the product sent wrong (missing data, unknown product group, ...) will not get better by retrying
    if (result.statusCode === 400 || result.statusCode === 404) break;
    if (attempt < attempts) await wait(retryDelayMs() * attempt);
  }
  const errorMessage = attemptError(result);
  logger.error(`create_opportunity -- ${tag} -- FAILED after ${attempt} attempt(s), sending error mail: ${errorMessage}`);
  if (result.failedRequest) {
    const opportunityError = { ...result.failedRequest, message: errorMessage, attempts: attempt, date: now() };
    await store
      .getCollection()
      .then((collection) => collection.updateOne(store.keyOf(product, reqId), { $set: { opportunityError, updatedDate: now() } }))
      .catch((err) => logger.error(`create_opportunity -- ${tag} -- saving failed payload failed: ${err.message}`));
  }
  const doc = (await loadDoc(product, reqId).catch(() => null)) || { productCode: product.productCode, reqId };
  await notify.sendFailureMail(product, doc, errorMessage, attempt).catch((err) => logger.error(`create_opportunity -- ${tag} -- error mail failed: ${err.message}`));
  await sendCallback(product, "failed", doc, { stage: "opportunity", error: errorMessage });
  return result;
};

// ---------- stage 2: sales order ----------

const salesOrderBlocked = (doc) => {
  const unknown = doc.salesOrderStatus === S.UNKNOWN;
  return httpError(
    409,
    unknown
      ? `Previous sales order creation for ${tagOf(doc.productCode, doc.reqId)} did not complete and may already exist in Oracle CRM (opportunity ${doc.opportunityNumber}). Reconcile it via /opportunity/save.`
      : `Sales order creation for ${tagOf(doc.productCode, doc.reqId)} is already in progress or awaiting reconciliation.`,
    { code: unknown ? "SALES_ORDER_OUTCOME_UNKNOWN" : "SALES_ORDER_IN_PROGRESS" }
  );
};

const createSalesOrder = async (collection, product, doc) => {
  const tag = tagOf(doc.productCode, doc.reqId);
  const log = `create_sales_order -- ${tag}`;
  const record = { productCode: doc.productCode, reqId: doc.reqId, opportunityId: doc.opportunityId };
  if (doc.salesOrderStatus === S.CREATED && doc.orderHeaderId) return { orderHeaderId: doc.orderHeaderId };
  if (doc.salesOrderStatus === S.IN_PROGRESS) throw salesOrderBlocked(doc);
  if (doc.salesOrderStatus === S.UNKNOWN) {
    logger.info(`${log} -- salesOrderStatus ${S.UNKNOWN}: looking it up in Oracle before creating again`);
    let found;
    try {
      found = await osc.findSalesOrderInOracle(product, doc, tag);
    } catch (e) {
      throw httpError(502, `Sales order outcome still unknown, Oracle lookup failed: ${e.message}`, {
        code: e.code === "LOOKUP_AMBIGUOUS" ? e.code : "SALES_ORDER_OUTCOME_UNKNOWN",
      });
    }
    if (found) {
      await retryDb("create_sales_order", tag, async () => {
        const saved = await collection.updateOne(record, {
          $set: { ...found, salesOrderStatus: S.CREATED, salesOrderReconciled: `oracle lookup ${now()}`, updatedDate: now() },
          $unset: { salesOrderAttemptedDate: "" },
        });
        if (!saved.matchedCount) throw new Error("no opportunity record matched");
      });
      logger.info(`${log} -- found in Oracle (orderHeaderId ${found.orderHeaderId}), saved without creating a second one`);
      return { ...found, createdNow: true };
    }
    logger.info(`${log} -- not found in Oracle, creating it again`);
    await collection.updateOne({ ...record, salesOrderStatus: S.UNKNOWN }, { $unset: { salesOrderStatus: "", salesOrderAttemptedDate: "" }, $set: { updatedDate: now() } });
    doc = { ...doc, salesOrderStatus: undefined };
  }
  // revenue lines sent with the opportunity; a record reconciled via /opportunity/save rebuilds them from the request
  let childRevenue = doc.opportunityPayload && doc.opportunityPayload.ChildRevenue;
  let oscPartyId = doc.oscpartyId;
  if (!Array.isArray(childRevenue) || !childRevenue.length || !validId(oscPartyId)) {
    if (!doc.request) throw httpError(400, `No request data saved for ${tag} to build the sales order`);
    if (!Array.isArray(childRevenue) || !childRevenue.length) childRevenue = P.buildChildRevenue(product, doc.request.lines, doc.request.contract);
    if (!validId(oscPartyId)) oscPartyId = doc.request.customer.oscPartyId;
  }
  const payload = P.buildSalesOrderPayload(product, {
    reqId: doc.reqId,
    opportunityId: doc.opportunityId,
    soldCustomerPartyId: oscPartyId,
    childRevenue,
    inProgressDate: new Date(),
  });

  const time = now();
  const lock = await collection.updateOne(
    { ...record, salesOrderStatus: { $nin: [S.IN_PROGRESS, S.UNKNOWN, S.CREATED] } },
    { $set: { salesOrderStatus: S.IN_PROGRESS, salesOrderAttemptedDate: time, updatedDate: time } }
  );
  if (lock.modifiedCount !== 1) {
    const current = (await collection.findOne(record)) || doc;
    if (current.salesOrderStatus === S.CREATED && current.orderHeaderId) return { orderHeaderId: current.orderHeaderId };
    throw salesOrderBlocked({ ...current, salesOrderStatus: current.salesOrderStatus || S.IN_PROGRESS });
  }
  logger.info(`${log} -- locked (salesOrderStatus ${S.IN_PROGRESS}) -- SoldCustomerPartyId: ${oscPartyId}`);

  let data;
  try {
    data = await callOracle("post", osc.SALES_ORDER_PATH, payload, { label: "create_sales_order", tag });
  } catch (e) {
    const update = e.rejected
      ? { $unset: { salesOrderStatus: "", salesOrderAttemptedDate: "" }, $set: { updatedDate: now() } }
      : { $set: { salesOrderStatus: S.UNKNOWN, updatedDate: now() } };
    await collection.updateOne(record, update).catch((err) => logger.error(`${log} -- lock update failed: ${err.message}`));
    if (e.rejected) throw e;
    throw httpError(502, `${e.message} -- sales order outcome unknown; the next attempt checks Oracle before creating again`, { code: "SALES_ORDER_OUTCOME_UNKNOWN" });
  }
  const created = P.extractSalesOrder(data);
  if (!created) {
    await collection.updateOne(record, { $set: { salesOrderStatus: S.UNKNOWN, updatedDate: now() } }).catch((err) => logger.error(`${log} -- lock update failed: ${err.message}`));
    throw httpError(502, `Sales order API did not return ${P.ORDER_HEADER_ID_FIELD}`, { code: "SALES_ORDER_OUTCOME_UNKNOWN" });
  }
  logger.info(`${log} -- orderHeaderId: ${created.orderHeaderId} -- created in Oracle`);
  try {
    await retryDb("create_sales_order", tag, async () => {
      const saved = await collection.updateOne(record, {
        $set: { ...created, salesOrderStatus: S.CREATED, salesOrderPayload: payload, updatedDate: now() },
        $unset: { salesOrderAttemptedDate: "" },
      });
      if (!saved.matchedCount) throw new Error("no opportunity record matched");
    });
  } catch (e) {
    logger.error(`${log} -- RECONCILE: sales order created but save failed -- orderHeaderId: ${created.orderHeaderId} -- Error: ${e.message}`);
    throw httpError(500, `Sales order (orderHeaderId ${created.orderHeaderId}) was created in Oracle CRM but could not be saved. Reconcile via /opportunity/save; do not retry.`, {
      code: "SALES_ORDER_NOT_SAVED",
    });
  }
  logger.info(`${log} -- saved: salesOrderStatus ${S.CREATED} -- OrderTotal: ${payload.OrderTotal} -- QuoteTCV_c: ${payload.QuoteTCV_c}`);
  return { ...created, createdNow: true };
};

// ---------- stages 3-7 ----------

const keyFilter = (doc, extra) => ({ productCode: doc.productCode, reqId: doc.reqId, ...extra });
const mustMatch = (saved) => {
  if (!saved.matchedCount) throw new Error("no opportunity record matched");
};

// stage 3: sales order Status "Proposal Approved"
const approveProposal = async (collection, product, doc, orderHeaderId) => {
  if (doc.approvalStatus === S.APPROVED) return;
  if (!validId(orderHeaderId)) throw httpError(400, `No orderHeaderId saved for ${tagOf(doc.productCode, doc.reqId)}`);
  const payload = P.buildProposalApprovedPayload();
  const data = await callOracle("patch", osc.salesOrderPath(orderHeaderId), payload, { label: "approve_proposal", tag: tagOf(doc.productCode, doc.reqId) });
  if (data && typeof data === "object" && data.Status !== undefined && data.Status !== P.PROPOSAL_APPROVED_STATUS) {
    throw httpError(502, `Sales order status update returned Status: ${data.Status}`);
  }
  mustMatch(await collection.updateOne(keyFilter(doc, { orderHeaderId }), { $set: { approvalStatus: S.APPROVED, approvalPayload: payload, approvedDate: now(), updatedDate: now() } }));
};

// stage 4: opportunity "proposal submitted" (sales stage + submission / effective date = today)
const submitProposal = async (collection, product, doc) => {
  if (doc.proposalSubmissionStatus === S.SUBMITTED) return;
  const tag = tagOf(doc.productCode, doc.reqId);
  if (doc.approvalStatus !== S.APPROVED) throw httpError(400, `Proposal not approved yet for ${tag}`);
  if (!validId(doc.opportunityNumber)) throw httpError(400, `No opportunityNumber saved for ${tag}`);
  const payload = P.buildProposalSubmittedPayload(product, new Date());
  const data = await callOracle("patch", osc.opportunityPath(doc.opportunityNumber), payload, { label: "submit_proposal", tag });
  if (data && typeof data === "object" && data.SalesStageId !== undefined && String(data.SalesStageId) !== String(product.stages.proposalSubmitted)) {
    throw httpError(502, `Opportunity update returned SalesStageId: ${data.SalesStageId}`);
  }
  mustMatch(await collection.updateOne(keyFilter(doc, { opportunityNumber: doc.opportunityNumber }), {
    $set: { proposalSubmissionStatus: S.SUBMITTED, proposalSubmissionPayload: payload, proposalSubmittedDate: now(), updatedDate: now() },
  }));
};

// stage 5: opportunity "PO received"
const receivePo = async (collection, product, doc) => {
  if (doc.poReceivedStatus === S.RECEIVED) return;
  const tag = tagOf(doc.productCode, doc.reqId);
  if (doc.proposalSubmissionStatus !== S.SUBMITTED) throw httpError(400, `Proposal not submitted yet for ${tag}`);
  if (!validId(doc.opportunityNumber)) throw httpError(400, `No opportunityNumber saved for ${tag}`);
  const payload = P.buildPoReceivedPayload(product, {
    proposalSubmissionDate: (doc.proposalSubmissionPayload && doc.proposalSubmissionPayload.XXSF_ProposalSubmissionDate_c) || doc.proposalSubmittedDate,
    date: new Date(),
  });
  const data = await callOracle("patch", osc.opportunityPath(doc.opportunityNumber), payload, { label: "po_received", tag });
  if (data && typeof data === "object" && data.SalesStageId !== undefined && String(data.SalesStageId) !== String(product.stages.poReceived)) {
    throw httpError(502, `Opportunity PO received update returned SalesStageId: ${data.SalesStageId}`);
  }
  mustMatch(await collection.updateOne(keyFilter(doc, { opportunityNumber: doc.opportunityNumber }), {
    $set: { poReceivedStatus: S.RECEIVED, poReceivedPayload: payload, poReceivedDate: now(), updatedDate: now() },
  }));
};

const attachmentBlocked = (doc) => {
  const unknown = doc.attachmentStatus === S.UNKNOWN;
  return httpError(
    409,
    unknown
      ? `Previous signed document upload for ${tagOf(doc.productCode, doc.reqId)} did not complete and may already be attached in Oracle CRM (opportunity ${doc.opportunityNumber}).`
      : `Signed document upload for ${tagOf(doc.productCode, doc.reqId)} is already in progress or awaiting reconciliation.`,
    { code: unknown ? "ATTACHMENT_OUTCOME_UNKNOWN" : "ATTACHMENT_IN_PROGRESS" }
  );
};

// stage 6: signed document (Base64) as opportunity attachment; a POST adds a new attachment each time, so it is locked
const uploadSignedDocument = async (collection, product, doc) => {
  const tag = tagOf(doc.productCode, doc.reqId);
  const log = `upload_signed_document -- ${tag} -- opportunityNumber: ${doc.opportunityNumber || "-"}`;
  if (doc.attachmentStatus === S.UPLOADED) return;
  if (doc.attachmentStatus === S.IN_PROGRESS) throw attachmentBlocked(doc);
  if (doc.poReceivedStatus !== S.RECEIVED) throw httpError(400, `PO not received yet for ${tag}`);
  if (!validId(doc.opportunityNumber)) throw httpError(400, `No opportunityNumber saved for ${tag}`);
  const url = osc.attachmentUrl(doc.opportunityNumber);
  const record = keyFilter(doc, { opportunityNumber: doc.opportunityNumber });
  const fileName = P.attachmentFileName(product, doc.reqId);
  if (doc.attachmentStatus === S.UNKNOWN) {
    logger.info(`${log} -- attachmentStatus ${S.UNKNOWN}: looking for ${fileName} among the opportunity attachments before posting again`);
    let found;
    try {
      found = await osc.findAttachmentInOracle(url, fileName, tag);
    } catch (e) {
      throw httpError(502, `PO document outcome still unknown, Oracle lookup failed: ${e.message}`, {
        code: e.code === "LOOKUP_AMBIGUOUS" ? e.code : "ATTACHMENT_OUTCOME_UNKNOWN",
      });
    }
    if (found) {
      await retryDb("upload_signed_document", tag, async () => {
        const set = {
          attachmentStatus: S.UPLOADED,
          attachmentPayload: { FileName: fileName, UploadedFileContentType: P.ATTACHMENT_CONTENT_TYPE, Title: product.attachment.title },
          attachmentReconciled: `oracle lookup ${now()}`,
          attachmentDate: now(),
          updatedDate: now(),
        };
        if (found.attachmentDocumentId) set.attachmentDocumentId = found.attachmentDocumentId;
        mustMatch(await collection.updateOne(record, { $set: set, $unset: { attachmentAttemptedDate: "" } }));
      });
      await documents.removeStoredDocument(doc).catch(() => {});
      return;
    }
    await collection.updateOne({ ...record, attachmentStatus: S.UNKNOWN }, { $unset: { attachmentStatus: "", attachmentAttemptedDate: "" }, $set: { updatedDate: now() } });
  }
  const document = await documents.getSignedDocument(doc, tag);
  const payload = P.buildAttachmentPayload(product, { reqId: doc.reqId, document });
  const { FileContents, ...payloadInfo } = payload; // the Base64 file is not stored on the record

  const time = now();
  const lock = await collection.updateOne(
    { ...record, attachmentStatus: { $nin: [S.IN_PROGRESS, S.UNKNOWN, S.UPLOADED] } },
    { $set: { attachmentStatus: S.IN_PROGRESS, attachmentAttemptedDate: time, updatedDate: time } }
  );
  if (lock.modifiedCount !== 1) {
    const current = (await collection.findOne(record)) || doc;
    if (current.attachmentStatus === S.UPLOADED) return;
    throw attachmentBlocked({ ...current, attachmentStatus: current.attachmentStatus || S.IN_PROGRESS });
  }
  let data;
  try {
    data = await callOracle("post", url, payload, { label: "upload_signed_document", tag });
  } catch (e) {
    const update = e.rejected
      ? { $unset: { attachmentStatus: "", attachmentAttemptedDate: "" }, $set: { updatedDate: now() } }
      : { $set: { attachmentStatus: S.UNKNOWN, updatedDate: now() } };
    await collection.updateOne(record, update).catch((err) => logger.error(`${log} -- lock update failed: ${err.message}`));
    if (e.rejected) throw e;
    throw httpError(502, `${e.message} -- PO document outcome unknown; the next attempt checks the opportunity attachments before posting again`, { code: "ATTACHMENT_OUTCOME_UNKNOWN" });
  }
  const attachmentDocumentId = P.extractAttachment(data);
  logger.info(`${log} -- ${payload.FileName} attached in Oracle -- AttachedDocumentId: ${attachmentDocumentId || "-"}`);
  try {
    const set = { attachmentStatus: S.UPLOADED, attachmentPayload: payloadInfo, attachmentFileSize: document.length, attachmentDate: now(), updatedDate: now() };
    if (attachmentDocumentId) set.attachmentDocumentId = attachmentDocumentId;
    await retryDb("upload_signed_document", tag, async () => {
      mustMatch(await collection.updateOne(record, { $set: set, $unset: { attachmentAttemptedDate: "" } }));
    });
  } catch (e) {
    logger.error(`${log} -- RECONCILE: attached but save failed -- AttachedDocumentId: ${attachmentDocumentId || "-"} -- Error: ${e.message}`);
    throw httpError(500, `Signed document was attached in Oracle CRM (AttachedDocumentId ${attachmentDocumentId || "-"}) but could not be saved. Reconcile via /opportunity/save; do not retry.`, {
      code: "ATTACHMENT_NOT_SAVED",
    });
  }
  await documents.removeStoredDocument(doc).catch((err) => logger.error(`${log} -- stored document cleanup failed: ${err.message}`));
};

// stage 7: sales order Status "Order To ERP"
const sendOrderToErp = async (collection, product, doc) => {
  if (doc.orderToErpStatus === S.SENT_TO_ERP) return;
  const tag = tagOf(doc.productCode, doc.reqId);
  if (doc.attachmentStatus !== S.UPLOADED) throw httpError(400, `PO document not attached yet for ${tag}`);
  if (!validId(doc.orderHeaderId)) throw httpError(400, `No orderHeaderId saved for ${tag}`);
  const payload = P.buildOrderToErpPayload();
  const data = await callOracle("patch", osc.salesOrderPath(doc.orderHeaderId), payload, { label: "order_to_erp", tag });
  if (data && typeof data === "object" && data.Status !== undefined && data.Status !== P.ORDER_TO_ERP_STATUS) {
    throw httpError(502, `Sales order Order To ERP update returned Status: ${data.Status}`);
  }
  mustMatch(await collection.updateOne(keyFilter(doc, { orderHeaderId: doc.orderHeaderId }), {
    $set: { orderToErpStatus: S.SENT_TO_ERP, orderToErpPayload: payload, orderToErpDate: now(), updatedDate: now() },
  }));
};

// final failure of a stage: mail + "failed" callback
const stageFailed = async (product, label, tag, outcome, stage, doc, rows) => {
  const errorMessage = (outcome.error && outcome.error.message) || String(outcome.error);
  logger.error(`${label} -- ${tag} -- FAILED after ${outcome.attempt} attempt(s), sending error mail: ${errorMessage}`);
  await notify.sendFailureMail(product, doc, errorMessage, outcome.attempt, { stage, doc, rows }).catch((err) =>
    logger.error(`${label} -- ${tag} -- error mail failed: ${err.message}`)
  );
  if (doc) await sendCallback(product, "failed", doc, { stage, error: errorMessage });
};

// stages 2-7 for one request; each stage only runs once the previous one is saved, stages 3-7 only once the order is placed
const runStages = async (product, reqId) => {
  const tag = tagOf(product.productCode, reqId);
  const key = store.keyOf(product, reqId);
  let collection;
  let doc;
  const load = async () => {
    collection = await store.getCollection();
    doc = await collection.findOne(key);
    if (!doc || !doc.opportunityId) throw httpError(404, `No saved opportunity for ${tag}`);
  };

  let salesOrderCreatedNow = false;
  const salesOrder = await withRetry("create_sales_order", tag, async () => {
    await load();
    if (doc.opportunityDropStatus === S.DROPPED || doc.quoteCancelStatus === S.CANCELLED) {
      throw httpError(409, `Opportunity ${doc.opportunityNumber} was dropped, stages 2-7 not run`);
    }
    if (doc.orderToErpStatus === S.SENT_TO_ERP) return null; // all stages done
    if (doc.approvalStatus === S.APPROVED) return doc.orderHeaderId;
    if (doc.salesOrderStatus === S.CREATED && doc.orderHeaderId) return doc.orderHeaderId;
    const { orderHeaderId, createdNow } = await createSalesOrder(collection, product, doc);
    salesOrderCreatedNow = !!createdNow;
    return orderHeaderId;
  });
  if (salesOrder.skipped) return;
  if (salesOrder.value === null) {
    logger.info(`opportunity_flow -- ${tag} -- all stages already done, nothing to run`);
    return;
  }
  if (salesOrder.error) return stageFailed(product, "create_sales_order", tag, salesOrder, "salesOrder", doc);
  const orderHeaderId = salesOrder.value;

  const reload = await withRetry("opportunity_flow", tag, load);
  if (reload.error) return stageFailed(product, "opportunity_flow", tag, reload, "flow", doc);

  if (salesOrderCreatedNow) {
    await notify.sendCreatedMail(product, doc).catch((err) => logger.error(`create_sales_order -- ${tag} -- created mail failed: ${err.message}`));
    await sendCallback(product, "salesOrder.created", doc);
  }
  if (!doc.orderPlaced && doc.approvalStatus !== S.APPROVED) {
    logger.info(`opportunity_flow -- ${tag} -- orderHeaderId: ${orderHeaderId} -- order not placed yet, stages 3-7 run once it is placed`);
    return;
  }

  const stages = [
    ["approve_proposal", "approval", () => approveProposal(collection, product, doc, orderHeaderId)],
    ["submit_proposal", "submission", () => submitProposal(collection, product, doc)],
    ["po_received", "poReceived", () => receivePo(collection, product, doc)],
    ["upload_signed_document", "attachment", () => uploadSignedDocument(collection, product, doc)],
    ["order_to_erp", "orderToErp", () => sendOrderToErp(collection, product, doc)],
  ];
  for (const [label, stage, run] of stages) {
    logger.info(`${label} -- ${tag} -- started`);
    const outcome = await withRetry(label, tag, async () => {
      await load();
      await run();
    });
    if (outcome.error) {
      const rows = stage === "attachment" ? [["PO Document", P.attachmentFileName(product, reqId)]] : undefined;
      return stageFailed(product, label, tag, outcome, stage, { ...doc, orderHeaderId }, rows);
    }
    if (outcome.skipped) return;
    logger.info(`${label} -- ${tag} -- done`);
  }
  logger.info(`opportunity_flow -- ${tag} -- COMPLETE -- opportunityNumber: ${doc.opportunityNumber} -- orderHeaderId: ${orderHeaderId}`);
  const saved = (await collection.findOne(key)) || { ...doc, orderHeaderId };
  await notify.sendSuccessMail(product, saved).catch((err) => logger.error(`opportunity_flow -- ${tag} -- success mail failed: ${err.message}`));
  await sendCallback(product, "flow.completed", saved);
};

// ---------- one active run per request (MongoDB lease lock) ----------
const leaseMs = () => parseInt(process.env.OPPORTUNITY_FLOW_LEASE_MS, 10) || 30 * 60 * 1000;
const MAX_RERUNS = 5;

const runFlow = async (product, reqId) => {
  const tag = tagOf(product.productCode, reqId);
  const key = store.keyOf(product, reqId);
  const collection = await store.getCollection();
  const owner = `${process.pid}-${crypto.randomUUID()}`;
  let acquired = false;
  for (let tries = 0; tries < 3 && !acquired; tries++) {
    const lock = await collection.updateOne(
      { ...key, $or: [{ flowLockUntil: { $exists: false } }, { flowLockUntil: { $lt: new Date() } }] },
      { $set: { flowLockUntil: new Date(Date.now() + leaseMs()), flowLockOwner: owner }, $unset: { flowRerun: "" } }
    );
    acquired = lock.modifiedCount === 1;
    if (!acquired) {
      // another run is active: it runs once more when it finishes, picking up what this trigger wanted
      const marked = await collection.updateOne({ ...key, flowLockUntil: { $gte: new Date() } }, { $set: { flowRerun: true } });
      if (marked.matchedCount === 1) {
        logger.info(`opportunity_flow -- ${tag} -- another run is active, it will run again when it finishes`);
        return;
      }
    }
  }
  if (!acquired) {
    logger.error(`opportunity_flow -- ${tag} -- could not take the flow lock, not run`);
    return;
  }
  for (let run = 0; run <= MAX_RERUNS; run++) {
    try {
      await runStages(product, reqId);
    } catch (err) {
      const message = (err && err.message) || String(err);
      logger.error(`opportunity_flow -- ${tag} -- unexpected error: ${message}${err && err.stack ? ` -- ${err.stack}` : ""}`);
      const doc = await collection.findOne(key).catch(() => null);
      await notify.sendFailureMail(product, doc || key, message, 1, { stage: "flow", doc }).catch(() => {});
    }
    const released = await collection.updateOne(
      { ...key, flowLockOwner: owner, flowRerun: { $ne: true } },
      { $unset: { flowLockUntil: "", flowLockOwner: "" } }
    );
    if (released.matchedCount === 1) return;
    // a trigger arrived during this run: keep the lock and run again
    const renewed = await collection.updateOne(
      { ...key, flowLockOwner: owner },
      { $unset: { flowRerun: "" }, $set: { flowLockUntil: new Date(Date.now() + leaseMs()) } }
    );
    if (renewed.matchedCount !== 1) return; // lease lost to another run
    logger.info(`opportunity_flow -- ${tag} -- triggered again during the run, running once more`);
  }
  await collection.updateOne({ ...key, flowLockOwner: owner }, { $unset: { flowLockUntil: "", flowLockOwner: "", flowRerun: "" } });
};

// background runs (tracked so tests / shutdown can wait for them)
const runs = new Set();
const track = (tag, promise) => {
  const run = logContext.run({ reqId: tag }, () => promise())
    .catch((err) => logger.error(`opportunity_flow -- ${tag} -- background run failed: ${(err && err.message) || err}`))
    .finally(() => runs.delete(run));
  runs.add(run);
  return run;
};

const startFlow = (product, reqId) => track(tagOf(product.productCode, reqId), () => runFlow(product, reqId));
const startCreate = (product, reqId) => track(tagOf(product.productCode, reqId), () => processOpportunity(product, reqId));

// resolves once every background run (and the runs they started) has finished
const settled = async () => {
  while (runs.size) await Promise.all([...runs]);
};

// order placed: saves the flag (and the signed document source) and starts stages 3-7 once the opportunity exists
const orderPlaced = async (product, reqId, attachment) => {
  const collection = await store.getCollection();
  const key = store.keyOf(product, reqId);
  const time = now();
  try {
    await collection.updateOne(key, { $set: { ...key, orderPlaced: true, orderPlacedDate: time, updatedDate: time }, $setOnInsert: { createdDate: time } }, { upsert: true });
  } catch (e) {
    if (e.code !== 11000) throw e;
    await collection.updateOne(key, { $set: { orderPlaced: true, orderPlacedDate: time, updatedDate: time } });
  }
  await documents.saveAttachmentSource(collection, key, attachment);
  const doc = await collection.findOne(key);
  if (!doc || !doc.opportunityId) {
    return { started: false, message: "Order placed saved; stages 3-7 run once the opportunity is created" };
  }
  startFlow(product, reqId);
  return { started: true, message: "Order placed saved; stages 3-7 started" };
};

module.exports = {
  normalizeRequest,
  acceptCreate,
  createOpportunityOnce,
  processOpportunity,
  runStages,
  runFlow,
  startFlow,
  startCreate,
  orderPlaced,
  settled,
};
