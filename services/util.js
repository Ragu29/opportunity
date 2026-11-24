const moment = require("moment");

const httpError = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra);
const clean = (value) => (value === undefined || value === null ? "" : String(value).trim());
const validId = (value) => !!clean(value) && clean(value) !== "-";
const round2 = (value) => Math.round(value * 100) / 100;
// dates stored on the opportunity record (createdDate, approvedDate, ...): "YYYY-MM-DD"
const now = () => moment().format("YYYY-MM-DD");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// reqId as each product knows it (CCD: "20000"); stored as a string so any product's ids fit
const REQ_ID = /^[A-Za-z0-9_-]{1,64}$/;
const toReqId = (value) => {
  const id = clean(value);
  return REQ_ID.test(id) ? id : null;
};

// "CCD/20000": the log / mail label of one request
const tagOf = (productCode, reqId) => `${productCode}/${reqId}`;

module.exports = { httpError, clean, validId, round2, now, wait, toReqId, tagOf };
