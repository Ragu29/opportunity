// CrossConnect Domestic: every value that was hardcoded in crossconnect-domestic/services/opportunityPayload.js
// and controller/opportunity.js. Sales stages belong to a sales method (Oracle LOV_SalesStageId): every stage id must
// be a stage of salesMethodId, otherwise Oracle answers 400 "no matching row".
module.exports = {
  productCode: "CCD",
  name: "CrossConnect Domestic",
  enabled: true,

  salesMethodId: "300000677571121",
  stages: {
    qualifiedLead: "300000677571122", // create: "01 - Qualified Lead"
    proposalSubmitted: "300000677571123", // "02 - Proposal Generated"
    poReceived: "300000677571124", // "03 - PO Received"
  },
  optyLeadBU: "300000659948788",
  opportunityTypeCode: "EXPANSION",
  // Oracle product group (sub product) per line productGroup sent by the product
  prodGroupIds: {
    Fiber: 300000659948822,
    Ethernet: 300000659948816,
    "Zero Manhole": 300000659806472,
  },

  namePrefix: "OSP_crossconnect_", // opportunity / sales order Name = namePrefix + reqId
  proposalPrefix: "PR", // ProposalId_c = proposalPrefix + reqId

  currency: "INR",
  source: "OSP",
  productType: "Sify Service",
  pricingModel: "Sify Price List",
  quoteValidityDays: 30,

  contact: { type: "Partner", countryCode: "91" },
  attachment: { title: "PO Document", filePrefix: "CCD-SO-" }, // FileName = filePrefix + reqId + ".pdf"
  drop: { afterDays: 90, reason: "CUSTOMER_NOT_READY" },

  mail: { subjectPrefix: "CCD", recipientsEnv: "MAIL_RECIPIENTS_CCD" },
  callbackUrlEnv: "CALLBACK_URL_CCD",
};
