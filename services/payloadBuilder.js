const moment = require("moment");
const { httpError, clean, round2 } = require("./util");

// pure helpers that build the Oracle CRM payloads (no DB / HTTP). Every product specific value comes from the
// product config (config/products/<code>.js); the Oracle field names and the revenue math are the same for all products.

// "20000" / "PR20000" -> "PR20000"
const proposalId = (product, reqId) => {
  const id = clean(reqId);
  const prefix = product.proposalPrefix;
  return id.toUpperCase().startsWith(prefix.toUpperCase()) ? `${prefix}${id.slice(prefix.length)}` : `${prefix}${id}`;
};

const opportunityName = (product, reqId) => `${product.namePrefix}${clean(reqId)}`;

// request created date -> "YYYY-MM-DD"; never falls back to today
const effectiveDate = (createdDate) => {
  const date = createdDate ? moment(createdDate instanceof Date ? createdDate : new Date(createdDate)) : null;
  if (!date || !date.isValid()) {
    throw httpError(400, "requestCreatedDate is missing or invalid");
  }
  return date.format("YYYY-MM-DD");
};

// { contractYears: 2 } -> 2; { contractPeriod: "1 Year" } -> 1, "2 Years" -> 2, "3 Months" -> 0.25
const contractYears = ({ contractYears: years, contractPeriod } = {}) => {
  if (clean(years) !== "") {
    const value = Number(years);
    if (!(value > 0)) throw httpError(400, `Unsupported contractYears: ${years}`);
    return value;
  }
  const match = clean(contractPeriod).match(/^(\d+(?:\.\d+)?)\s*(year|month)s?$/i);
  const value = match ? Number(match[1]) : 0;
  if (!match || !(value > 0)) {
    throw httpError(400, `Unsupported contractPeriod: ${contractPeriod}`);
  }
  return match[2].toLowerCase() === "year" ? value : value / 12;
};

// ARC / OTC must be present and >= 0 (0 is a valid zero-price plan; missing is not)
const amount = (value, label, group) => {
  const num = clean(value) === "" ? NaN : Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw httpError(400, `${label} missing or invalid for productGroup: ${group}`);
  }
  return num;
};

// one revenue line per request line { productGroup, quantity, totalArc, totalOtc } (totals already rate x quantity)
// UnitPrice = (ARC + OTC) / Quantity (Oracle values the line as UnitPrice x Quantity, which must equal the sales order
// value), TCV_c = OTC + ARC x contract years
const buildChildRevenue = (product, lines, contract) => {
  const years = contractYears(contract);
  const childRevenue = [];
  for (const line of lines || []) {
    const group = line && line.productGroup;
    const quantity = Number(line && line.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw httpError(400, `Invalid quantity for productGroup: ${group}`);
    }
    if (quantity === 0) continue;
    const prodGroupId = product.prodGroupIds[group];
    if (!prodGroupId) {
      throw httpError(400, `No ProdGroupId configured for productGroup: ${group} (product ${product.productCode})`);
    }
    const arc = amount(line.totalArc, "totalArc", group);
    const otc = amount(line.totalOtc, "totalOtc", group);
    childRevenue.push({
      ProdGroupId: prodGroupId,
      UnitPrice: round2((arc + otc) / quantity),
      TCV_c: round2(otc + arc * years),
      Quantity: quantity,
    });
  }
  if (!childRevenue.length) {
    throw httpError(400, "No line with a valid quantity on the request");
  }
  return childRevenue;
};

// contact person -> Oracle contact create payload
const buildContactPayload = (product, { contact, accountPartyId }) => {
  const mobile = clean(contact.mobile);
  return {
    FirstName: clean(contact.firstName),
    LastName: clean(contact.lastName),
    Type: product.contact.type,
    AccountPartyId: clean(accountPartyId),
    MobileCountryCode: product.contact.countryCode,
    MobileNumber: mobile,
    EmailAddress: clean(contact.email),
    WorkPhoneCountryCode: product.contact.countryCode,
    WorkPhoneNumber: mobile,
  };
};

const requireIds = (label, values) => {
  for (const [key, value] of Object.entries(values)) {
    if (!clean(value) || clean(value) === "-") {
      throw httpError(400, `${label}: ${key} is required`);
    }
  }
};

const buildOpportunityPayload = (product, { reqId, ownerResourcePartyId, targetPartyId, keyContactId, effectiveDate: date, childRevenue }) => {
  requireIds("Opportunity payload", { reqId, ownerResourcePartyId, targetPartyId, keyContactId, effectiveDate: date });
  if (!Array.isArray(childRevenue) || !childRevenue.length) {
    throw httpError(400, "Opportunity payload: ChildRevenue is required");
  }
  return {
    ProposalId_c: proposalId(product, reqId),
    SalesMethodId: product.salesMethodId,
    SalesStageId: product.stages.qualifiedLead,
    Name: opportunityName(product, reqId),
    OwnerResourcePartyId: clean(ownerResourcePartyId),
    TargetPartyId: clean(targetPartyId),
    XXSI_OptyLeadBU_c: product.optyLeadBU,
    KeyContactId: clean(keyContactId),
    OpportunityTypeCode: product.opportunityTypeCode,
    EffectiveDate: date,
    ChildRevenue: childRevenue,
  };
};

// Oracle create response -> { opportunityId, opportunityNumber }; null when either is missing
const extractOpportunity = (data) => {
  const opportunityId = clean(data && data.OptyId);
  const opportunityNumber = clean(data && data.OptyNumber);
  return opportunityId && opportunityNumber ? { opportunityId, opportunityNumber } : null;
};

// ---------- stage 2: sales order (quote "In Progress") ----------
const SALES_ORDER_STATUS = "In Progress";
const SALES_ORDER_VERSION = 1;

const quoteValidityDate = (product, inProgressDate) => moment(inProgressDate).add(product.quoteValidityDays, "days").format("YYYY-MM-DD");

// one sales order line per opportunity revenue line, same value as the opportunity: Amount = UnitPrice,
// OrderTotal = sum of Amount x Quantity, QuoteTCV_c = sum of TCV_c, so the CPQ quote value equals the opportunity value
const buildSalesOrderPayload = (product, { reqId, opportunityId, soldCustomerPartyId, childRevenue, inProgressDate }) => {
  requireIds("Sales order payload", { reqId, opportunityId, soldCustomerPartyId });
  if (!Array.isArray(childRevenue) || !childRevenue.length) {
    throw httpError(400, "Sales order payload: opportunity revenue lines are required");
  }
  const partyId = Number(soldCustomerPartyId);
  if (!Number.isSafeInteger(partyId)) {
    throw httpError(400, `Sales order payload: invalid soldCustomerPartyId ${soldCustomerPartyId}`);
  }
  const optyId = clean(opportunityId);
  const lines = childRevenue.map((line, index) => ({
    OptyId: optyId,
    InventoryOrgId: line.ProdGroupId,
    ProdGroupId_c: line.ProdGroupId,
    Quantity: line.Quantity,
    Amount: line.UnitPrice,
    ExternalOrderLineNumber: index + 1,
    CurrencyCode: product.currency,
    ProductType_c: product.productType,
    TCV_c: line.TCV_c,
    PricingModel_c: product.pricingModel,
    LineSource_c: product.source,
    MarginPercentage_c: null,
    OEM_c: null,
    NoOfRacks_c: null,
    TotalPowerDensityInKW_c: null,
    RFSDate_c: null,
    DataCenterLocation_c: null,
  }));
  return {
    CurrencyCode: product.currency,
    Name: opportunityName(product, reqId),
    OptyId: optyId,
    OrderTotal: round2(lines.reduce((sum, l) => sum + l.Amount * l.Quantity, 0)),
    QuoteTCV_c: round2(lines.reduce((sum, l) => sum + l.TCV_c, 0)),
    SoldCustomerPartyId: partyId,
    XXSF_QuoteNumber_c: clean(reqId),
    VersionNumber: SALES_ORDER_VERSION,
    SourceInternalSystem_c: product.source,
    Status: SALES_ORDER_STATUS,
    QuoteValidityDate_c: quoteValidityDate(product, inProgressDate),
    SalesOrderLine: lines,
  };
};

const ORDER_HEADER_ID_FIELD = "OrderHeaderId";
const extractSalesOrder = (data) => {
  const orderHeaderId = clean(data && data[ORDER_HEADER_ID_FIELD]);
  return orderHeaderId ? { orderHeaderId } : null;
};

// ---------- stages 3 + 7: sales order status (PATCH salesOrders/{orderHeaderId}); exact Oracle LOV values ----------
const PROPOSAL_APPROVED_STATUS = "Proposal Approved";
const ORDER_TO_ERP_STATUS = "Order To ERP";
const buildProposalApprovedPayload = () => ({ Status: PROPOSAL_APPROVED_STATUS });
const buildOrderToErpPayload = () => ({ Status: ORDER_TO_ERP_STATUS });

// ---------- stage 4: proposal submitted (PATCH opportunities/{opportunityNumber}) ----------
const OPPORTUNITY_FIELDS = "SalesMethodId,SalesStageId,Name,OwnerResourcePartyId,TargetPartyId,XXSI_OptyLeadBU_c,KeyContactId,OptyNumber,OptyId";

const buildProposalSubmittedPayload = (product, date) => {
  const day = moment(date).format("YYYY-MM-DD");
  return {
    XXSF_ProposalSubmissionDate_c: day,
    SalesMethodId: product.salesMethodId,
    SalesStageId: product.stages.proposalSubmitted,
    EffectiveDate: day,
  };
};

// ---------- stage 5: PO received (same PATCH) ----------
const buildPoReceivedPayload = (product, { proposalSubmissionDate, date }) => {
  const submitted = clean(proposalSubmissionDate);
  if (!submitted) {
    throw httpError(400, "PO received payload: proposal submission date is required");
  }
  return {
    XXSF_ProposalSubmissionDate_c: submitted,
    SalesStageId: product.stages.poReceived,
    EffectiveDate: moment(date).format("YYYY-MM-DD"),
  };
};

// ---------- stage 6: signed document as opportunity attachment ----------
const ATTACHMENT_CONTENT_TYPE = "application/pdf";
const attachmentFileName = (product, reqId) => `${product.attachment.filePrefix}${clean(reqId)}.pdf`;
const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 4).toString() === "%PDF";

const buildAttachmentPayload = (product, { reqId, document }) => {
  if (!clean(reqId)) {
    throw httpError(400, "Attachment payload: reqId is required");
  }
  if (!isPdf(document)) {
    throw httpError(400, `Attachment payload: signed document for reqId ${clean(reqId)} is not a PDF`);
  }
  return {
    FileName: attachmentFileName(product, reqId),
    UploadedFileContentType: ATTACHMENT_CONTENT_TYPE,
    Title: product.attachment.title,
    FileContents: document.toString("base64"),
  };
};

const extractAttachment = (data) => clean(data && (data.AttachedDocumentId || data.DocumentId)) || null;

// ---------- drop: quote cancel + opportunity DROPPED ----------
const QUOTE_CANCELLED_STATUS = "Cancelled";
const OPPORTUNITY_DROPPED_STATUS = "DROPPED";
const buildQuoteCancelPayload = () => ({ Status: QUOTE_CANCELLED_STATUS });
const buildOpportunityDropPayload = (product) => ({
  StatusCode: OPPORTUNITY_DROPPED_STATUS,
  PrimaryReason_c: product.drop.reason,
  ReasonWonLostCode: product.drop.reason,
});

module.exports = {
  proposalId,
  opportunityName,
  effectiveDate,
  contractYears,
  buildChildRevenue,
  buildContactPayload,
  buildOpportunityPayload,
  extractOpportunity,
  quoteValidityDate,
  buildSalesOrderPayload,
  ORDER_HEADER_ID_FIELD,
  extractSalesOrder,
  PROPOSAL_APPROVED_STATUS,
  ORDER_TO_ERP_STATUS,
  buildProposalApprovedPayload,
  buildOrderToErpPayload,
  OPPORTUNITY_FIELDS,
  buildProposalSubmittedPayload,
  buildPoReceivedPayload,
  ATTACHMENT_CONTENT_TYPE,
  attachmentFileName,
  isPdf,
  buildAttachmentPayload,
  extractAttachment,
  QUOTE_CANCELLED_STATUS,
  OPPORTUNITY_DROPPED_STATUS,
  buildQuoteCancelPayload,
  buildOpportunityDropPayload,
};
