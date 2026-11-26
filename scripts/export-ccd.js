// Rollback helper: copies this service's CCD records back into crossconnect-domestic's ccd_opportunity, so the
// in-process flow (USE_OPPORTUNITY_SERVICE=false) can finish requests the service started. Without it the in-process
// flow finds no record for them: order placed would wait forever, and a new create would make a second opportunity.
// Run it BEFORE crossconnect-domestic is restarted with the switch off, with this service stopped (pm2 stop
// onesify-opportunity) so nothing changes during the copy.
//
//   node scripts/export-ccd.js            -> dry run
//   node scripts/export-ccd.js --apply    -> copies (rules in scripts/ccdRecords.js: insert or fill in missing fields,
//                                            never overwrite; safe to run again)
//
// Env: as migrate-ccd.js (SOURCE_MONGODB_DBNAME = the CCD network DB).
const { connect, run, main, SERVICE_ONLY_FIELDS } = require("./ccdRecords");

const apply = process.argv.includes("--apply");

main(async () => {
  const { client, ccd, service, names } = await connect();
  try {
    console.log(`${names.service} -> ${names.ccd}`);
    const sources = (await service.find({ productCode: "CCD" }).toArray()).filter((doc) => Number.isInteger(Number(doc.reqId)));
    await run({
      apply,
      label: "export opportunity service -> CCD",
      sources,
      toTarget: ({ _id, ...doc }) => {
        const record = { ...doc, reqId: Number(doc.reqId) };
        for (const field of SERVICE_ONLY_FIELDS) delete record[field];
        return record;
      },
      targetOf: (record) => ccd.findOne({ reqId: record.reqId }),
      write: async (record, plan) => {
        if (plan.action === "insert") await ccd.insertOne(record);
        else await ccd.updateOne({ reqId: record.reqId }, { $set: plan.set });
      },
    });
  } finally {
    await client.close();
  }
});
