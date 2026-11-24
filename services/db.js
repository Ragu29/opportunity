const { MongoClient } = require("mongodb");
const logger = require("../config/logger");

// this service owns its own collections; it never reads product collections (quoteccds, ...)
//   opportunities         - one record per (productCode, reqId): request data + every Oracle step status / id
//   opportunity_documents - signed documents sent with /order-placed (Base64), used by stage 6
let client = null;
let collections = null;

const connect = async () => {
  const { MONGODB_CLUSTER, MONGODB_DBNAME, DB_USERNAME, DB_PASSWORD } = process.env;
  if (!MONGODB_CLUSTER || !MONGODB_DBNAME) throw new Error("MONGODB_CLUSTER / MONGODB_DBNAME not configured");
  client = new MongoClient(MONGODB_CLUSTER, {
    ...(DB_USERNAME ? { auth: { username: DB_USERNAME, password: DB_PASSWORD }, authSource: "admin" } : {}),
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });
  await client.connect();
  const db = client.db(MONGODB_DBNAME);
  collections = {
    opportunities: db.collection("opportunities"),
    documents: db.collection("opportunity_documents"),
  };
  logger.info(`Database | connected to MongoDB ${MONGODB_DBNAME}`);
  return collections;
};

let connecting = null;
const getCollections = async () => {
  if (collections) return collections;
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
};

// tests inject in-memory collections
const setCollections = (value) => {
  collections = value;
};

const close = async () => {
  if (client) await client.close();
  client = null;
  collections = null;
};

module.exports = { getCollections, setCollections, close };
