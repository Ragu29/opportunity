const logger = require("../config/logger");
const { callOracle } = require("./oscClient");
const P = require("./payloadBuilder");
const { httpError, clean, validId } = require("./util");

// Oracle CRM REST paths (relative to OPPORTUNITY_BASE_URL) - the same for every product
const OPPORTUNITY_PATH = "/crmRestApi/resources/11.13.18.05/opportunities";
const SALES_ORDER_PATH = "/crmRestApi/resources/11.13.18.05/salesOrders";
const CONTACT_PATH = "/crmCommonApi/resources/11.12.1.0/contacts?onlyData=true&fields=ContactName,PartyId,AccountName,EmailAddress,OverallPrimaryFormattedPhoneNumber";

const salesOrderPath = (orderHeaderId) => `${SALES_ORDER_PATH}/${encodeURIComponent(orderHeaderId)}`;
const opportunityPath = (opportunityNumber) =>
  `${OPPORTUNITY_PATH}/${encodeURIComponent(opportunityNumber)}?onlyData=true&fields=${P.OPPORTUNITY_FIELDS}`;
const opportunityDropPath = (opportunityNumber) => `${OPPORTUNITY_PATH}/${encodeURIComponent(opportunityNumber)}`;
const accountTeamPath = (oscPartyNo) =>
  `/crmRestApi/resources/11.13.18.05/accounts/${encodeURIComponent(oscPartyNo)}/child/AccountTeam?onlyData=true&fields=ResourceId,OwnerFlag`;

// stage 6 URL per environment: OPPORTUNITY_ATTACHMENT_URL = {host}/salesApi/resources/11.12.1.0/opportunities
const attachmentUrl = (opportunityNumber) => {
  const base = clean(process.env.OPPORTUNITY_ATTACHMENT_URL).replace(/\/+$/, "");
  if (!base) {
    throw httpError(500, "Oracle attachment API URL (OPPORTUNITY_ATTACHMENT_URL) not configured", { rejected: true });
  }
  return `${base}/${encodeURIComponent(opportunityNumber)}/child/Attachment`;
};

// account owner (OwnerFlag true) from Oracle AccountTeam, used as OwnerResourcePartyId
const getOwnerResourceId = async (tag, oscPartyNo) => {
  const data = await callOracle("get", accountTeamPath(oscPartyNo), undefined, { label: "account_team", tag });
  if (!data || !Array.isArray(data.items)) {
    throw httpError(502, "AccountTeam API returned an unexpected response");
  }
  const owner = data.items.find((m) => String(m.OwnerFlag) === "true");
  if (!owner || !validId(owner.ResourceId)) {
    throw httpError(404, `No account owner found in AccountTeam for oscPartyNo: ${oscPartyNo}`);
  }
  logger.info(`create_opportunity -- ${tag} -- OwnerResourcePartyId: ${clean(owner.ResourceId)} (AccountTeam owner of oscPartyNo ${oscPartyNo})`);
  return clean(owner.ResourceId);
};

// ---------- lookups: make a create (POST) safe to retry after an unknown outcome (timeout / 5xx) ----------
// each returns the record found in Oracle, null when Oracle answered and it is not there, and throws when Oracle cannot
// be asked (the outcome then stays unknown). More than one match is never guessed.
const lookupItems = (label, data) => {
  if (!data || !Array.isArray(data.items)) {
    throw httpError(502, `${label} lookup returned an unexpected response`);
  }
  return data.items;
};
const onlyOne = (label, matches, what) => {
  if (matches.length > 1) {
    throw httpError(502, `${label} lookup found ${matches.length} records for ${what}; reconcile manually via /opportunity/save`, { code: "LOOKUP_AMBIGUOUS" });
  }
  return matches[0] || null;
};

// opportunity by its Name (namePrefix + reqId) -> { opportunityId, opportunityNumber } | null
const findOpportunityInOracle = async (product, reqId, tag) => {
  const name = P.opportunityName(product, reqId);
  const data = await callOracle(
    "get",
    `${OPPORTUNITY_PATH}?q=${encodeURIComponent(`Name='${name}'`)}&onlyData=true&fields=OptyId,OptyNumber,Name`,
    undefined,
    { label: "find_opportunity", tag }
  );
  const matches = lookupItems("Opportunity", data).filter((i) => clean(i.Name) === name).map(P.extractOpportunity).filter(Boolean);
  return onlyOne("Opportunity", matches, name);
};

// sales order of the opportunity (OptyId + Name / quote number) -> { orderHeaderId } | null
const findSalesOrderInOracle = async (product, doc, tag) => {
  const name = P.opportunityName(product, doc.reqId);
  const data = await callOracle(
    "get",
    `${SALES_ORDER_PATH}?q=${encodeURIComponent(`OptyId=${doc.opportunityId}`)}&onlyData=true&fields=OrderHeaderId,OptyId,Name,Status,XXSF_QuoteNumber_c`,
    undefined,
    { label: "find_sales_order", tag }
  );
  const matches = lookupItems("Sales order", data)
    .filter((i) => clean(i.OptyId) === clean(doc.opportunityId) && (clean(i.Name) === name || clean(i.XXSF_QuoteNumber_c) === clean(doc.reqId)))
    .map(P.extractSalesOrder)
    .filter(Boolean);
  return onlyOne("Sales order", matches, `opportunity ${doc.opportunityId}`);
};

// signed document among the opportunity attachments (by FileName) -> { attachmentDocumentId } | null
const findAttachmentInOracle = async (url, fileName, tag) => {
  const data = await callOracle("get", `${url}?onlyData=true&fields=AttachedDocumentId,FileName,Title`, undefined, { label: "find_attachment", tag });
  const matches = lookupItems("Attachment", data)
    .filter((i) => clean(i.FileName) === fileName)
    .map((i) => ({ attachmentDocumentId: P.extractAttachment(i) }));
  return onlyOne("Attachment", matches, fileName);
};

module.exports = {
  OPPORTUNITY_PATH,
  SALES_ORDER_PATH,
  CONTACT_PATH,
  salesOrderPath,
  opportunityPath,
  opportunityDropPath,
  accountTeamPath,
  attachmentUrl,
  getOwnerResourceId,
  findOpportunityInOracle,
  findSalesOrderInOracle,
  findAttachmentInOracle,
};
