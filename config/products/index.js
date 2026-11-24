const { httpError, clean } = require("../../services/util");

// product registry. To onboard a product: add <code>.js next to ccd.js and list it here.
const PRODUCTS = [require("./ccd"), require("./ccc")];

// fields every enabled product must define (checked at startup so a bad config never reaches Oracle)
const REQUIRED = [
  "salesMethodId",
  "stages.qualifiedLead",
  "stages.proposalSubmitted",
  "stages.poReceived",
  "optyLeadBU",
  "opportunityTypeCode",
  "namePrefix",
  "proposalPrefix",
  "currency",
  "source",
  "productType",
  "pricingModel",
  "quoteValidityDays",
  "contact.type",
  "contact.countryCode",
  "attachment.title",
  "attachment.filePrefix",
  "drop.afterDays",
  "drop.reason",
  "mail.subjectPrefix",
];

const get = (obj, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), obj);

const validate = (product) => {
  const missing = REQUIRED.filter((path) => clean(get(product, path)) === "");
  if (!product.prodGroupIds || !Object.keys(product.prodGroupIds).length) missing.push("prodGroupIds");
  return missing;
};

const registry = new Map();
for (const product of PRODUCTS) {
  const code = clean(product.productCode).toUpperCase();
  if (!code) throw new Error("Product config without productCode");
  if (registry.has(code)) throw new Error(`Duplicate product config: ${code}`);
  if (product.enabled) {
    const missing = validate(product);
    if (missing.length) throw new Error(`Product ${code} is enabled but its config is missing: ${missing.join(", ")}`);
  }
  registry.set(code, Object.freeze({ ...product, productCode: code }));
}

// product config for a request; 400 when the product is unknown or not enabled yet
const getProductConfig = (productCode) => {
  const code = clean(productCode).toUpperCase();
  if (!code) throw httpError(400, "productCode is required");
  const product = registry.get(code);
  if (!product) throw httpError(400, `Unknown productCode: ${code}`);
  if (!product.enabled) throw httpError(400, `Product ${code} is not enabled for opportunity creation yet`);
  return product;
};

const listProducts = () => [...registry.values()].map((p) => ({ productCode: p.productCode, name: p.name, enabled: !!p.enabled }));

module.exports = { getProductConfig, listProducts, validate };
