// CrossConnect corp (/home/sslportal/onesify/crossconnect). DISABLED until the Oracle ids below are confirmed by the
// OSC / business team. Each id that is null must be filled in; then set enabled: true.
// Copy ccd.js as a starting point when a value is the same for corp (e.g. optyLeadBU, salesMethodId).
module.exports = {
  productCode: "CCC",
  name: "CrossConnect Corporate",
  enabled: false,

  salesMethodId: null,
  stages: {
    qualifiedLead: null,
    proposalSubmitted: null,
    poReceived: null,
  },
  optyLeadBU: null,
  opportunityTypeCode: null,
  prodGroupIds: {
    // "Fiber": 300000000000000,
  },

  namePrefix: "OSP_crossconnect_corp_",
  proposalPrefix: "PR",

  currency: "INR",
  source: "OSP",
  productType: "Sify Service",
  pricingModel: "Sify Price List",
  quoteValidityDays: 30,

  contact: { type: "Partner", countryCode: "91" },
  attachment: { title: "PO Document", filePrefix: "CCC-SO-" },
  drop: { afterDays: 90, reason: "CUSTOMER_NOT_READY" },

  mail: { subjectPrefix: "CrossConnect Corp", recipientsEnv: "MAIL_RECIPIENTS_CCC" },
  callbackUrlEnv: "CALLBACK_URL_CCC",
};
