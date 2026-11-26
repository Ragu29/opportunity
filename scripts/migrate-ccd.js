// Copies crossconnect-domestic's ccd_opportunity records into this service's opportunities collection (productCode
// "CCD", reqId as string), so requests already in flight finish here after CCD switches to USE_OPPORTUNITY_SERVICE=true.
// Run it right after crossconnect-domestic was restarted with the switch on (its in-process flow no longer runs then).
//
//   node scripts/migrate-ccd.js            -> dry run: prints what would be copied
//   node scripts/migrate-ccd.js --apply    -> copies (rules in scripts/ccdRecords.js: insert or fill in missing fields,
//                                             never overwrite; safe to run again)
//
// Env: the usual MONGODB_* of this service, plus SOURCE_MONGODB_DBNAME = the CCD network DB (crossconnect-domestic
// MONGODB_DBNAME). Both DBs must be on the same cluster / credentials.
// Records listed as "not finished" are started with POST /opportunity/retry { productCode: "CCD", reqId }.
const { connect, run, main } = require("./ccdRecords");

const apply = process.argv.includes("--apply");

main(async () => {
  const { client, ccd, service, names } = await connect();
  try {
    console.log(`${names.ccd} -> ${names.service}`);
    const sources = await ccd.find({}).toArray();
    await run({
      apply,
      label: "migrate CCD -> opportunity service",
      sources,
      toTarget: ({ _id, ...doc }) => {
        const record = { ...doc, productCode: "CCD", reqId: String(doc.reqId), migratedFrom: `ccd_opportunity ${_id}` };
        // customer data for the status mails (a record without an opportunity gets the full request with the next create)
        if (doc.opportunityId) {
          record.request = { customer: { ebsAccountNo: doc.ebsAccountNo || "", companyName: doc.companyName || "", oscPartyId: doc.oscpartyId || "", oscPartyNo: "" } };
        }
        return record;
      },
      targetOf: (record) => service.findOne({ productCode: "CCD", reqId: record.reqId }),
      write: async (record, plan) => {
        if (plan.action === "insert") await service.insertOne(record);
        else await service.updateOne({ productCode: "CCD", reqId: record.reqId }, { $set: plan.set });
      },
    });
  } finally {
    await client.close();
  }
});
