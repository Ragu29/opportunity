// One-time copy of crossconnect-domestic's ccd_opportunity records into this service's opportunities collection
// (productCode "CCD", reqId as string), so requests already in flight finish here after the switch.
//
//   node scripts/migrate-ccd.js            -> dry run: prints what would be copied
//   node scripts/migrate-ccd.js --apply    -> copies (idempotent: an existing record is never overwritten)
//
// Env: the usual MONGODB_* of this service, plus SOURCE_MONGODB_DBNAME = the CCD network DB (crossconnect-domestic
// MONGODB_DBNAME). Both DBs must be on the same cluster / credentials.
require("../services/envConfig");
const { MongoClient } = require("mongodb");

const apply = process.argv.includes("--apply");

const main = async () => {
  const { MONGODB_CLUSTER, MONGODB_DBNAME, SOURCE_MONGODB_DBNAME, DB_USERNAME, DB_PASSWORD } = process.env;
  if (!MONGODB_CLUSTER || !MONGODB_DBNAME || !SOURCE_MONGODB_DBNAME) {
    throw new Error("MONGODB_CLUSTER, MONGODB_DBNAME and SOURCE_MONGODB_DBNAME are required");
  }
  const client = new MongoClient(MONGODB_CLUSTER, DB_USERNAME ? { auth: { username: DB_USERNAME, password: DB_PASSWORD }, authSource: "admin" } : {});
  await client.connect();
  try {
    const source = client.db(SOURCE_MONGODB_DBNAME).collection("ccd_opportunity");
    const target = client.db(MONGODB_DBNAME).collection("opportunities");
    const docs = await source.find({}).toArray();
    let copied = 0;
    let skipped = 0;
    for (const { _id, ...doc } of docs) {
      const reqId = String(doc.reqId);
      const key = { productCode: "CCD", reqId };
      if (await target.findOne(key)) {
        skipped++;
        continue;
      }
      const record = {
        ...doc,
        ...key,
        migratedFrom: `ccd_opportunity ${_id}`,
        // request data used by the status mails (stage 2 uses opportunityPayload / oscpartyId already on the record)
        request: doc.request || {
          customer: { ebsAccountNo: doc.ebsAccountNo || "", companyName: doc.companyName || "", oscPartyId: doc.oscpartyId || "", oscPartyNo: "" },
        },
      };
      console.log(`${apply ? "copy" : "would copy"} CCD/${reqId} -- opportunity ${doc.opportunityNumber || "-"} -- sales order ${doc.orderHeaderId || "-"} -- ${doc.orderToErpStatus ? "complete" : "in flight"}`);
      if (apply) await target.insertOne(record);
      copied++;
    }
    console.log(`${apply ? "copied" : "dry run, would copy"} ${copied}, already present ${skipped}, total ${docs.length}`);
  } finally {
    await client.close();
  }
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
