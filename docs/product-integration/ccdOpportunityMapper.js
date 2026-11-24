// Example for crossconnect-domestic: builds the opportunity service /create body from its own data.
// This is the logic that stays in the product (it knows its collections); everything Oracle moves to the service.
// Sources are the same as crossconnect-domestic/controller/opportunity.js today:
//   quoteccds (quote), companies (oscpartyNo by ebsaccountNo), oscpartyId from body / token claim / quote creator.
const clean = (v) => (v === undefined || v === null ? "" : String(v).trim());

// contact person: the common contact, or (isCommonAll false) the first link contact - same rule as getContactInfo today
const contactOf = (quote) => {
  const common = quote.contact_info || {};
  if (common.isCommonAll !== false) return common;
  const types = [...(quote.planDetails || []).map((p) => p.type), ...Object.keys(quote.dmark_details || {})];
  for (const type of [...new Set(types)]) {
    const links = Array.isArray(quote.dmark_details?.[type]) ? quote.dmark_details[type] : [];
    const first = [...links]
      .sort((a, b) => Number(a.Connection) - Number(b.Connection))
      .find((link) => clean(link.contact_info?.firstName) && clean(link.contact_info?.emailId));
    if (first) return first.contact_info;
  }
  return {};
};

// quote (quoteccds), company (companies), oscpartyId (resolved as today) -> /opportunity/create body
exports.toCreateRequest = (quote, company, oscpartyId) => {
  const contact = contactOf(quote);
  return {
    reqId: String(quote.reqId),
    customer: {
      oscPartyNo: clean(company.oscpartyNo),
      oscPartyId: clean(oscpartyId),
      ebsAccountNo: clean(quote.ebsAccountNo),
      companyName: clean(company.companyName || quote.companyName),
    },
    contact: {
      firstName: clean(contact.firstName),
      lastName: clean(contact.lastName),
      mobile: clean(contact.mobileNo),
      email: clean(contact.emailId),
    },
    // planDetails type (Fiber / Ethernet / Zero Manhole) = productGroup in the CCD product config
    lines: (quote.planDetails || []).map((p) => ({ productGroup: p.type, quantity: p.quantity, totalArc: p.totalArc, totalOtc: p.totalOtc })),
    contractPeriod: quote.contractPeriod,
    requestCreatedDate: quote.createdDate,
  };
};
