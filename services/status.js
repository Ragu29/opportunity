// status values stored on the opportunity record
// opportunityStatus / salesOrderStatus / attachmentStatus track each Oracle create (POST) so a retry never creates a
// second record:
//   IN_PROGRESS - create running (or the process stopped / DB save failed after Oracle answered)
//   UNKNOWN     - Oracle timed out / 5xx / answered without ids: the record may exist in Oracle; the next attempt
//                 looks it up in Oracle before posting again
//   CREATED     - ids saved
module.exports = {
  IN_PROGRESS: "IN_PROGRESS",
  UNKNOWN: "UNKNOWN",
  CREATED: "CREATED",
  APPROVED: "APPROVED",
  SUBMITTED: "SUBMITTED",
  RECEIVED: "RECEIVED",
  UPLOADED: "UPLOADED",
  SENT_TO_ERP: "SENT",
  CANCELLED: "CANCELLED",
  DROPPED: "DROPPED",
  KEY_CONTACT_EXISTING: "EXISTING",
  KEY_CONTACT_CREATED: "CREATED",
};
