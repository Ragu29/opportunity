const moment = require("moment");
const logger = require("../config/logger");
const { sendMail } = require("./mailer");
const P = require("./payloadBuilder");
const S = require("./status");
const { clean, validId, wait } = require("./util");
const { retryAttempts, retryDelayMs } = require("./retry");

// status mails (error + success), same layout as the CCD mails; subject prefix and recipients per product
const mailTime = (date) => moment(date).format("DD-MMM-YYYY hh:mm A");
const envLabel = () => (process.env.NODE_ENV === "prod" ? "Production" : "Demo");
const escapeHtml = (value) => clean(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const recipients = (product) =>
  clean(product.mail.recipientsEnv && process.env[product.mail.recipientsEnv])
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

// failure texts per stage: [subject, title, summary]
const failureText = (product, stage) => {
  const texts = {
    opportunity: ["opportunity creation", "CRM opportunity creation failed", "The opportunity could not be created in Oracle CRM"],
    orderPlaced: [
      "order placed CRM update",
      "CRM update after Order Placed could not be started",
      "The order was placed, but the CRM steps (Proposal Approved, proposal submitted, PO received, PO document, Order To ERP) could not be started",
    ],
    flow: ["opportunity flow", "CRM opportunity flow stopped with an unexpected error", "The CRM opportunity flow stopped with an unexpected error (outside the Oracle calls)"],
    salesOrder: [
      "sales order creation",
      "CRM sales order (Quote In Progress) creation failed",
      "The opportunity was created, but the sales order (Quote In Progress) could not be created in Oracle CRM",
    ],
    approval: [
      "sales order status update",
      `CRM sales order status update (${P.PROPOSAL_APPROVED_STATUS}) failed`,
      `The opportunity and sales order were created, but the sales order status could not be updated to ${P.PROPOSAL_APPROVED_STATUS} in Oracle CRM`,
    ],
    submission: [
      "opportunity proposal submission update",
      "CRM opportunity proposal submission update failed",
      `The opportunity and sales order were created and approved, but the opportunity sales stage (${product.stages.proposalSubmitted}) / proposal submission date could not be updated in Oracle CRM`,
    ],
    poReceived: [
      "opportunity PO received update",
      "CRM opportunity PO received update failed",
      `The proposal submission was completed, but the opportunity sales stage could not be updated to PO received (${product.stages.poReceived}) in Oracle CRM`,
    ],
    attachment: [
      "PO document upload",
      "CRM PO document (signed document) upload failed",
      "The opportunity was updated to PO received, but the PO document (signed document) could not be attached to the opportunity in Oracle CRM",
    ],
    orderToErp: [
      "sales order Order To ERP update",
      `CRM sales order status update (${P.ORDER_TO_ERP_STATUS}) failed`,
      `The PO document was sent to Oracle CRM, but the sales order status could not be updated to ${P.ORDER_TO_ERP_STATUS}`,
    ],
    quoteCancel: [
      "quote cancel (drop)",
      "CRM sales order (quote) cancel failed",
      `The sales order (quote) status could not be updated to ${P.QUOTE_CANCELLED_STATUS} in Oracle CRM, so the opportunity was not dropped either`,
    ],
    opportunityDrop: ["opportunity drop", "CRM opportunity drop failed", `The opportunity status could not be updated to ${P.OPPORTUNITY_DROPPED_STATUS} in Oracle CRM`],
  };
  return texts[stage] || texts.flow;
};

// request rows shown first in every mail (request data sent by the product with /opportunity/create)
const requestRows = (product, doc) => {
  const request = (doc && doc.request) || {};
  const customer = request.customer || {};
  return [
    ["Product", `${product.name} (${product.productCode})`],
    ["Request ID", doc ? doc.reqId : "N/A"],
    ["Company Name", customer.companyName || (doc && doc.companyName) || "N/A"],
    ["EBS Account Number", customer.ebsAccountNo || (doc && doc.ebsAccountNo) || "N/A"],
    ["Request Created Date", request.requestCreatedDate ? mailTime(request.requestCreatedDate) : "N/A"],
  ];
};

const sendStatusMail = async (product, { subject, color, title, summary, rows }) => {
  const to = recipients(product);
  if (!to.length) {
    logger.info(`mail -- "${subject}" -- no recipients configured (${product.mail.recipientsEnv}), not sent`);
    return;
  }
  const html = `
    <div style="font-family: Segoe UI, Arial, sans-serif; max-width: 700px;">
      <h3 style="color: ${color};">${escapeHtml(product.mail.subjectPrefix)} - ${title}</h3>
      <p>${summary}</p>
      <table style="border-collapse: collapse; width: 100%;">
        ${rows.map(([label, value]) => `<tr>
          <td style="border: 1px solid #e0e0e0; padding: 8px; background: #f5f5f5;"><strong>${label}</strong></td>
          <td style="border: 1px solid #e0e0e0; padding: 8px;">${escapeHtml(value)}</td>
        </tr>`).join("")}
      </table>
    </div>`;
  const attempts = retryAttempts();
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await sendMail({ to, subject, html });
      if (!response || !response.success) throw new Error((response && response.error) || "mail not sent");
      if (attempt > 1) logger.info(`mail -- "${subject}" -- sent on attempt ${attempt}/${attempts}`);
      return;
    } catch (e) {
      logger.error(`mail -- "${subject}" -- attempt ${attempt}/${attempts} failed: ${e.message}`);
      if (attempt >= attempts) throw e;
      await wait(retryDelayMs() * attempt);
    }
  }
};

// failure = { stage, doc, rows } ; doc = the opportunity record (may be the request only, for stage 1)
const sendFailureMail = async (product, doc, errorMessage, attempts, failure = {}) => {
  const stage = failure.stage || "opportunity";
  const [subjectText, title, summaryText] = failureText(product, stage);
  const d = failure.doc || doc || {};
  await sendStatusMail(product, {
    subject: `${product.mail.subjectPrefix} ${subjectText} failed (${envLabel()}) - ${d.reqId}`,
    color: "#d32f2f",
    title,
    summary: `${summaryText} after ${attempts} attempt(s). The order flow was not affected.`,
    rows: [
      ...requestRows(product, d),
      ...(d.opportunityNumber ? [["Opportunity Number", d.opportunityNumber], ["Opportunity ID", d.opportunityId]] : []),
      ...(d.orderHeaderId ? [["Order Header ID", d.orderHeaderId]] : []),
      ...(failure.rows || []),
      ["Attempts", attempts],
      ["Error", errorMessage],
      ["Failed At", mailTime(new Date())],
    ],
  });
};

// success mail 1 of 2: opportunity + sales order "In Progress" created
const sendCreatedMail = async (product, doc) => {
  const salesOrder = doc.salesOrderPayload || {};
  await sendStatusMail(product, {
    subject: `${product.mail.subjectPrefix} opportunity and sales order created (${envLabel()}) - ${doc.reqId}`,
    color: "#2e7d32",
    title: "CRM opportunity and sales order (Quote In Progress) created",
    summary: doc.orderPlaced
      ? "The opportunity and the sales order (Quote In Progress) were created in Oracle CRM. The order is already placed, so the remaining CRM steps are running now."
      : "The opportunity and the sales order (Quote In Progress) were created in Oracle CRM. The remaining CRM steps (Proposal Approved, proposal submitted, PO received, PO document, Order To ERP) run once the order is placed.",
    rows: [
      ...requestRows(product, doc),
      ["Opportunity Number", doc.opportunityNumber],
      ["Opportunity ID", doc.opportunityId],
      ["Owner Resource Party ID", doc.OwnerResourcePartyId || "N/A"],
      ["Key Contact ID", doc.KeyContactId || "N/A"],
      ["Key Contact", doc.keyContactStatus === S.KEY_CONTACT_EXISTING
        ? `Existing contact (same name, mobile and email${doc.keyContactReusedFrom ? `, from request ${doc.keyContactReusedFrom}` : ""}) - not created again`
        : doc.keyContactStatus === S.KEY_CONTACT_CREATED ? "New contact created in Oracle CRM" : "N/A"],
      ["Effective Date", doc.EffectiveDate || "N/A"],
      ["Order Header ID", doc.orderHeaderId],
      ["Sales Order Status", salesOrder.Status || "In Progress"],
      ["Order Total", salesOrder.OrderTotal !== undefined ? `${salesOrder.CurrencyCode || ""} ${salesOrder.OrderTotal}`.trim() : "N/A"],
      ["Quote TCV", salesOrder.QuoteTCV_c !== undefined ? salesOrder.QuoteTCV_c : "N/A"],
      ["Quote Validity Date", salesOrder.QuoteValidityDate_c || "N/A"],
      ["Created At", mailTime(new Date())],
    ],
  });
};

// success mail 2 of 2: stages 3-7 done
const sendSuccessMail = async (product, doc) => {
  const submitted = doc.proposalSubmissionPayload || {};
  const received = doc.poReceivedPayload || {};
  const attached = doc.attachmentPayload || {};
  await sendStatusMail(product, {
    subject: `${product.mail.subjectPrefix} opportunity creation successful - PO document sent (${envLabel()}) - ${doc.reqId}`,
    color: "#2e7d32",
    title: `CRM opportunity completed, PO document sent and sales order ${P.ORDER_TO_ERP_STATUS}`,
    summary: `The PO document (signed document) was attached to the opportunity in Oracle CRM and the sales order status was updated to ${P.ORDER_TO_ERP_STATUS}.`,
    rows: [
      ...requestRows(product, doc),
      ["Opportunity Number", doc.opportunityNumber],
      ["Opportunity ID", doc.opportunityId],
      ["Key Contact ID", doc.KeyContactId || "N/A"],
      ["Order Header ID", doc.orderHeaderId],
      ["Sales Order Status", `${P.PROPOSAL_APPROVED_STATUS} -> ${P.ORDER_TO_ERP_STATUS}`],
      ["Proposal Submitted Stage ID", submitted.SalesStageId || product.stages.proposalSubmitted],
      ["Proposal Submission Date", submitted.XXSF_ProposalSubmissionDate_c || "N/A"],
      ["PO Received Stage ID", received.SalesStageId || product.stages.poReceived],
      ["PO Received Date", received.EffectiveDate || "N/A"],
      ["PO Document Sent", attached.FileName ? `${attached.FileName} (${attached.Title})` : "N/A"],
      ["PO Document Size", doc.attachmentFileSize ? `${Math.round(doc.attachmentFileSize / 1024)} KB` : "N/A"],
      ["Attached Document ID", doc.attachmentDocumentId || "N/A"],
      ["Order To ERP Date", doc.orderToErpDate || "N/A"],
      ["Completed At", mailTime(new Date())],
    ],
  });
};

// alert mail: request dropped (quote cancelled when there was one, opportunity DROPPED)
const sendDroppedMail = async (product, doc, requestStatus) => {
  const withQuote = validId(doc.orderHeaderId);
  await sendStatusMail(product, {
    subject: `${product.mail.subjectPrefix} opportunity dropped (${envLabel()}) - ${doc.reqId}`,
    color: "#ef6c00",
    title: `CRM opportunity dropped${requestStatus ? ` - request in ${escapeHtml(requestStatus)}` : ""}`,
    summary: `The request was reported stale by ${product.productCode}${requestStatus ? ` (status ${escapeHtml(requestStatus)})` : ""} more than ${product.drop.afterDays} days after its opportunity was created. ${withQuote ? `The sales order (quote) was set to ${P.QUOTE_CANCELLED_STATUS}, ` : "No sales order (quote) was created, "}the opportunity was set to ${P.OPPORTUNITY_DROPPED_STATUS} in Oracle CRM.`,
    rows: [
      ...requestRows(product, doc),
      ["Request Status", requestStatus || "N/A"],
      ["Opportunity Number", doc.opportunityNumber],
      ["Opportunity ID", doc.opportunityId || "N/A"],
      ["Opportunity Created Date", doc.opportunityCreatedDate || doc.createdDate || "N/A"],
      ["Order Header ID", withQuote ? doc.orderHeaderId : "N/A (no quote created)"],
      ["Quote Status", withQuote ? `${P.QUOTE_CANCELLED_STATUS} (${doc.quoteCancelledDate || "-"})` : "N/A"],
      ["Opportunity Status", `${P.OPPORTUNITY_DROPPED_STATUS} (${doc.opportunityDroppedDate || "-"})`],
      ["Drop Reason", product.drop.reason],
      ["Dropped At", mailTime(new Date())],
    ],
  });
};

module.exports = { sendFailureMail, sendCreatedMail, sendSuccessMail, sendDroppedMail, recipients };
