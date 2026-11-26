const axios = require("axios");
const logger = require("../config/logger");
const { httpsAgent } = require("./tls");
const P = require("./payloadBuilder");
const store = require("./store");
const { httpError, clean, now } = require("./util");

// signed document for stage 6. The product sends it with /order-placed, either
//   attachment.base64 - the PDF itself (stored in opportunity_documents until it is attached), or
//   attachment.url    - a URL this service downloads it from (only hosts listed in ALLOWED_DOCUMENT_HOSTS)
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const allowedHosts = () =>
  clean(process.env.ALLOWED_DOCUMENT_HOSTS)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

const checkUrl = (value) => {
  let url;
  try {
    url = new URL(clean(value));
  } catch (e) {
    throw httpError(400, "attachment.url is not a valid URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw httpError(400, "attachment.url must be http(s)");
  if (!allowedHosts().includes(url.hostname.toLowerCase())) {
    throw httpError(400, `attachment.url host ${url.hostname} is not in ALLOWED_DOCUMENT_HOSTS`);
  }
  return url.toString();
};

// validates the attachment of an /order-placed body -> { base64Buffer } | { url } | null (nothing sent)
const parseAttachment = (attachment) => {
  if (!attachment) return null;
  if (clean(attachment.base64)) {
    const buffer = Buffer.from(clean(attachment.base64), "base64");
    if (!P.isPdf(buffer)) throw httpError(400, "attachment.base64 is not a PDF");
    if (buffer.length > MAX_DOCUMENT_BYTES) throw httpError(413, `attachment is larger than ${MAX_DOCUMENT_BYTES} bytes`);
    return { buffer };
  }
  if (clean(attachment.url)) return { url: checkUrl(attachment.url) };
  throw httpError(400, "attachment needs base64 or url");
};

// saves the signed document source for a request (Base64 in opportunity_documents, or the URL on the record)
const saveAttachmentSource = async (collection, key, parsed) => {
  if (!parsed) return;
  if (parsed.buffer) {
    const documents = await store.getDocuments();
    await documents.updateOne(
      key,
      { $set: { ...key, contentBase64: parsed.buffer.toString("base64"), size: parsed.buffer.length, updatedDate: now() }, $setOnInsert: { createdDate: now() } },
      { upsert: true }
    );
    await collection.updateOne(key, { $set: { attachmentSource: "stored", updatedDate: now() }, $unset: { attachmentUrl: "" } });
  } else {
    await collection.updateOne(key, { $set: { attachmentSource: "url", attachmentUrl: parsed.url, updatedDate: now() } });
  }
};

// signed document (PDF Buffer) for stage 6
const getSignedDocument = async (doc, tag) => {
  const log = `upload_signed_document -- ${tag}`;
  const key = { productCode: doc.productCode, reqId: doc.reqId };
  const documents = await store.getDocuments();
  const stored = await documents.findOne(key);
  if (stored && stored.contentBase64) {
    const buffer = Buffer.from(stored.contentBase64, "base64");
    if (P.isPdf(buffer)) {
      logger.info(`${log} -- signed document read from opportunity_documents (${buffer.length} bytes)`);
      return buffer;
    }
    logger.error(`${log} -- stored document is not a PDF (${buffer.length} bytes)`);
  }
  if (!clean(doc.attachmentUrl)) {
    throw httpError(400, `No signed document for ${tag}: send attachment (base64 or url) with /opportunity/order-placed`);
  }
  const url = checkUrl(doc.attachmentUrl);
  logger.info(`${log} -- GET ${url}`);
  let response;
  try {
    response = await axios.request({
      method: "get",
      url,
      responseType: "arraybuffer",
      maxContentLength: MAX_DOCUMENT_BYTES,
      // certificate verified; TLS_CA_FILE supplies the intermediate when the host does not send it (services/tls.js)
      httpsAgent: httpsAgent(),
      timeout: 30000,
    });
  } catch (e) {
    const reason = (e.response && e.response.status) || e.code || e.message;
    logger.error(`${log} -- signed document download failed: ${reason}`);
    throw httpError(502, `Signed document download failed: ${reason}`);
  }
  const document = Buffer.from(response.data || []);
  if (!P.isPdf(document)) {
    logger.error(`${log} -- download is not a PDF (${document.length} bytes)`);
    throw httpError(404, `Signed document not available for ${tag} (document not signed yet?)`);
  }
  logger.info(`${log} -- signed document downloaded (${document.length} bytes)`);
  return document;
};

// the Base64 copy is not needed once the document is attached in Oracle
const removeStoredDocument = async (doc) => {
  const documents = await store.getDocuments();
  await documents.deleteOne({ productCode: doc.productCode, reqId: doc.reqId });
};

module.exports = { parseAttachment, saveAttachmentSource, getSignedDocument, removeStoredDocument, MAX_DOCUMENT_BYTES };
