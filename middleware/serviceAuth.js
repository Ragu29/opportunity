const crypto = require("crypto");
const { clean } = require("../services/util");

// service-to-service auth: each product service sends its own key in the x-api-key header.
// SERVICE_API_KEYS="CCD:key1,CCC:key2" -> a caller can only act on the product its key belongs to.
const parseKeys = () =>
  clean(process.env.SERVICE_API_KEYS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf(":");
      return index > 0 ? { productCode: entry.slice(0, index).trim().toUpperCase(), key: entry.slice(index + 1).trim() } : null;
    })
    .filter((entry) => entry && entry.key);

// constant time compare (hash first so different lengths don't leak through timing)
const digest = (value) => crypto.createHash("sha256").update(value).digest();
const sameKey = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

module.exports = (req, res, next) => {
  const key = clean(req.headers["x-api-key"]);
  if (!key) {
    return res.status(401).send({ status: "Error", code: "UNAUTHORIZED", message: "x-api-key header is required" });
  }
  const match = parseKeys().find((entry) => sameKey(entry.key, key));
  if (!match) {
    return res.status(401).send({ status: "Error", code: "UNAUTHORIZED", message: "Invalid API key" });
  }
  const productCode = clean((req.params && req.params.productCode) || (req.body && req.body.productCode)).toUpperCase();
  if (productCode && productCode !== match.productCode) {
    return res.status(403).send({ status: "Error", code: "FORBIDDEN", message: `This API key is not allowed for product ${productCode}` });
  }
  req.callerProduct = match.productCode;
  next();
};
