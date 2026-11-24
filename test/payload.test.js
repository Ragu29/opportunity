require("./helpers");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const P = require("../services/payloadBuilder");
const { getProductConfig, listProducts, validate } = require("../config/products");

const CCD = getProductConfig("CCD");

describe("product registry", () => {
  test("CCD is enabled, lookup is case insensitive", () => {
    assert.equal(getProductConfig("ccd").productCode, "CCD");
  });
  test("unknown product -> 400", () => {
    assert.throws(() => getProductConfig("XYZ"), { statusCode: 400, message: /Unknown productCode/ });
  });
  test("missing product -> 400", () => {
    assert.throws(() => getProductConfig(""), { statusCode: 400 });
  });
  test("CrossConnect corp stays disabled until its Oracle ids are filled in", () => {
    assert.throws(() => getProductConfig("CCC"), { statusCode: 400, message: /not enabled/ });
    assert.deepEqual(listProducts().find((p) => p.productCode === "CCC").enabled, false);
    assert.ok(validate(require("../config/products/ccc")).includes("salesMethodId"));
  });
});

describe("CCD payloads are identical to the crossconnect-domestic ones", () => {
  const childRevenue = P.buildChildRevenue(
    CCD,
    [
      { productGroup: "Fiber", quantity: 2, totalArc: 2000, totalOtc: 500 },
      { productGroup: "Ethernet", quantity: 0, totalArc: 0, totalOtc: 0 },
      { productGroup: "Zero Manhole", quantity: 3, totalArc: 1000, totalOtc: 0 },
    ],
    { contractPeriod: "2 Years" }
  );

  test("revenue: UnitPrice = (ARC + OTC) / qty, TCV = OTC + ARC x years, zero quantity skipped", () => {
    assert.deepEqual(childRevenue, [
      { ProdGroupId: 300000659948822, UnitPrice: 1250, TCV_c: 4500, Quantity: 2 },
      { ProdGroupId: 300000659806472, UnitPrice: 333.33, TCV_c: 2000, Quantity: 3 },
    ]);
  });

  test("opportunity payload", () => {
    assert.deepEqual(
      P.buildOpportunityPayload(CCD, { reqId: "20000", ownerResourcePartyId: 1, targetPartyId: 2, keyContactId: 3, effectiveDate: "2026-10-20", childRevenue }),
      {
        ProposalId_c: "PR20000",
        SalesMethodId: "300000677571121",
        SalesStageId: "300000677571122",
        Name: "OSP_crossconnect_20000",
        OwnerResourcePartyId: "1",
        TargetPartyId: "2",
        XXSI_OptyLeadBU_c: "300000659948788",
        KeyContactId: "3",
        OpportunityTypeCode: "EXPANSION",
        EffectiveDate: "2026-10-20",
        ChildRevenue: childRevenue,
      }
    );
  });

  test("sales order payload", () => {
    const payload = P.buildSalesOrderPayload(CCD, { reqId: "20000", opportunityId: "99", soldCustomerPartyId: "300000619458508", childRevenue, inProgressDate: new Date(2026, 10, 1) });
    assert.equal(payload.Name, "OSP_crossconnect_20000");
    assert.equal(payload.CurrencyCode, "INR");
    assert.equal(payload.OrderTotal, 3499.99);
    assert.equal(payload.QuoteTCV_c, 6500);
    assert.equal(payload.SoldCustomerPartyId, 300000619458508);
    assert.equal(payload.QuoteValidityDate_c, "2026-12-01");
    assert.equal(payload.Status, "In Progress");
    assert.deepEqual(payload.SalesOrderLine[0], {
      OptyId: "99",
      InventoryOrgId: 300000659948822,
      ProdGroupId_c: 300000659948822,
      Quantity: 2,
      Amount: 1250,
      ExternalOrderLineNumber: 1,
      CurrencyCode: "INR",
      ProductType_c: "Sify Service",
      TCV_c: 4500,
      PricingModel_c: "Sify Price List",
      LineSource_c: "OSP",
      MarginPercentage_c: null,
      OEM_c: null,
      NoOfRacks_c: null,
      TotalPowerDensityInKW_c: null,
      RFSDate_c: null,
      DataCenterLocation_c: null,
    });
  });

  test("stage payloads use the product stage ids", () => {
    assert.equal(P.buildProposalSubmittedPayload(CCD, new Date(2026, 10, 2)).SalesStageId, "300000677571123");
    assert.equal(P.buildPoReceivedPayload(CCD, { proposalSubmissionDate: "2026-11-02", date: new Date() }).SalesStageId, "300000677571124");
    assert.deepEqual(P.buildOpportunityDropPayload(CCD), { StatusCode: "DROPPED", PrimaryReason_c: "CUSTOMER_NOT_READY", ReasonWonLostCode: "CUSTOMER_NOT_READY" });
  });

  test("attachment payload", () => {
    const payload = P.buildAttachmentPayload(CCD, { reqId: "20000", document: Buffer.from("%PDF-1.4 x") });
    assert.equal(payload.FileName, "CCD-SO-20000.pdf");
    assert.equal(payload.Title, "PO Document");
    assert.throws(() => P.buildAttachmentPayload(CCD, { reqId: "1", document: Buffer.from("nope") }), { statusCode: 400 });
  });
});

describe("validation", () => {
  test("contract period / years", () => {
    assert.equal(P.contractYears({ contractPeriod: "3 Months" }), 0.25);
    assert.equal(P.contractYears({ contractYears: 5 }), 5);
    assert.throws(() => P.contractYears({ contractPeriod: "forever" }), { statusCode: 400 });
  });
  test("unknown product group -> 400", () => {
    assert.throws(() => P.buildChildRevenue(CCD, [{ productGroup: "Copper", quantity: 1, totalArc: 1, totalOtc: 1 }], { contractYears: 1 }), {
      statusCode: 400,
      message: /No ProdGroupId configured for productGroup: Copper/,
    });
  });
  test("missing ARC -> 400 (0 is valid)", () => {
    assert.throws(() => P.buildChildRevenue(CCD, [{ productGroup: "Fiber", quantity: 1, totalOtc: 1 }], { contractYears: 1 }), { statusCode: 400 });
    assert.equal(P.buildChildRevenue(CCD, [{ productGroup: "Fiber", quantity: 1, totalArc: 0, totalOtc: 0 }], { contractYears: 1 })[0].UnitPrice, 0);
  });
  test("proposal id keeps an existing prefix", () => {
    assert.equal(P.proposalId(CCD, "pr123"), "PR123");
  });
});
