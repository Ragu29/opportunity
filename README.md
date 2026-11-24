# OneSify Opportunity Service

This service creates opportunities in Oracle Sales Cloud (OSC) for every OneSify product. It holds all OSC calls, retries, idempotency, status mails and the drop logic. A product service (crossconnect-domestic, crossconnect corp, ...) only sends its request data and a `productCode`.

```
crossconnect-domestic ─┐   HTTPS + x-api-key
crossconnect (corp) ───┼──► opportunity service ──► Oracle Sales Cloud
future product ────────┘        │      ▲
                                │      └─ callbacks: opportunity.created, salesOrder.created, flow.completed, failed, dropped
                                └─ MongoDB: opportunities, opportunity_documents
```

## How it differs per product

The Oracle calls and payload shapes are the same for every product. Only the values in `config/products/<code>.js` change: sales method, stage ids, lead BU, product group ids, opportunity type, name / proposal prefix, currency, attachment title, drop rule and mail subject.

| Code | Product | Status |
|---|---|---|
| `CCD` | CrossConnect Domestic | enabled (values taken from crossconnect-domestic) |
| `CCC` | CrossConnect Corporate | **disabled**: fill in the Oracle ids in `config/products/ccc.js`, then set `enabled: true` |

The service refuses to start if an enabled product is missing a required value.

## Flow

| Stage | Oracle call | Trigger |
|---|---|---|
| 1 | AccountTeam owner → contact (reused if the same name, mobile and email already exist for the account) → `POST opportunities` | `POST /opportunity/create` |
| 2 | `POST salesOrders` (Quote "In Progress") | right after stage 1 |
| 3 | `PATCH salesOrders` Status "Proposal Approved" | `POST /opportunity/order-placed` |
| 4 | `PATCH opportunities` stage "Proposal submitted" | after 3 |
| 5 | `PATCH opportunities` stage "PO received" | after 4 |
| 6 | `POST opportunities/{no}/child/Attachment` (signed PDF) | after 5 |
| 7 | `PATCH salesOrders` Status "Order To ERP" | after 6 |
| drop | `PATCH salesOrders` "Cancelled", then `PATCH opportunities` "DROPPED" | `POST /opportunity/drop` |

How failures are handled:

- **Retries.** Every step is retried (`OPPORTUNITY_RETRY_ATTEMPTS`, default 4). After the last attempt, one failure mail goes out and a `failed` callback is sent.
- **No duplicates.** Each create (opportunity, sales order, attachment) is locked as `IN_PROGRESS` / `UNKNOWN` / `CREATED`. After a timeout or 5xx, the next attempt looks the record up in Oracle before posting again, so nothing is created twice.
- **One run at a time.** Stages 2–7 of a request run under a MongoDB lease lock, so only one run is active even with several pm2 instances. A trigger that arrives during a run makes that run go once more.

## API

The base path is `/onesify/opportunity/api/v1/opportunity`. Every call needs the `x-api-key` header, and a key only works for its own product (`SERVICE_API_KEYS=CCD:...,CCC:...`).

### `POST /create` → 202
```json
{
  "productCode": "CCD",
  "reqId": "20000",
  "customer": { "oscPartyNo": "2016", "oscPartyId": "300000619458508", "ebsAccountNo": "EBS1", "companyName": "Acme" },
  "contact":  { "firstName": "Asha", "lastName": "K", "mobile": "9876543210", "email": "asha@example.com" },
  "lines":    [{ "productGroup": "Fiber", "quantity": 2, "totalArc": 2000, "totalOtc": 500 }],
  "contractPeriod": "1 Year",
  "requestCreatedDate": "2026-10-20T05:00:00.000Z"
}
```
- Everything is validated first: a bad request gets a 400 before any Oracle call.
- `productGroup` must be a key of the product's `prodGroupIds`.
- `contractYears` (number) can be sent instead of `contractPeriod`.
- Revenue: `UnitPrice = (ARC + OTC) / quantity`, `TCV = OTC + ARC × years`.

### `POST /order-placed` → 202
`{ "productCode", "reqId", "attachment": { "base64": "<signed PDF>" } }` or `"attachment": { "url": "https://<allowed host>/..." }`
- Starts stages 3–7. If the opportunity doesn't exist yet, the flag is kept and the stages run once it is created.
- Sending it again re-runs only what is still missing, for example after stage 6 failed because the document wasn't signed yet.
- A URL is only downloaded from hosts listed in `ALLOWED_DOCUMENT_HOSTS`.

### Other endpoints
| Call | Purpose |
|---|---|
| `GET /:productCode/:reqId` | Ids and status of every step |
| `POST /retry` `{productCode, reqId}` | Run again whatever is missing (after fixing the cause of a failure mail) |
| `POST /save` `{productCode, reqId, opportunityId, opportunityNumber, orderHeaderId?, attachmentDocumentId?, retryAttachment?}` | Reconcile ids that exist in Oracle but were not saved |
| `GET /drop-candidates/:productCode[?includeDropped=true]` | Opportunities older than the product's drop period |
| `POST /drop` `{productCode, reqId, requestStatus?}` | Cancel quote + drop opportunity. Refused (409) if too recent, order placed, or a step is in progress |
| `GET /products` | Configured products |
| `GET /onesify/opportunity/api/v1/health` | Health check (no key) |

### Callbacks
The service sends `POST` to the product's `CALLBACK_URL_<CODE>` with `Authorization: Bearer <CALLBACK_TOKEN>`:
```json
{ "event": "opportunity.created", "productCode": "CCD", "reqId": "20000", "opportunityId": "...", "opportunityNumber": "...", "orderHeaderId": null, "at": "..." }
```
- Events: `opportunity.created`, `salesOrder.created`, `flow.completed`, `failed` (with `stage` and `error`), `dropped`.
- Callbacks are retried, then logged. Treat them as hints: `GET /:productCode/:reqId` is always the source of truth.

## Connecting a product

1. **Config:** add or fill `config/products/<code>.js` with that product's Oracle ids, register it in `config/products/index.js`, and set `enabled: true`.
2. **Keys and URLs:** in this service's env, add `<CODE>:<key>` to `SERVICE_API_KEYS`, plus `CALLBACK_URL_<CODE>` and `MAIL_RECIPIENTS_<CODE>`.
3. **In the product service:**
   - Copy [docs/product-integration/opportunityClient.js](docs/product-integration/opportunityClient.js).
   - Write a mapper from its quote to the `/create` body. [ccdOpportunityMapper.js](docs/product-integration/ccdOpportunityMapper.js) is the CCD example.
   - Call `create` when the quote is ready and `orderPlaced` when the order is placed.
   - Add a callback route that saves `opportunityId` / `opportunityNumber` on its request.
4. **Drop (only if the product drops stale requests):** a daily job calls `dropCandidates()`. For each candidate whose own status is still stale, it calls `drop()`. On `dropped` / `already_dropped`, the product hides its request (CCD: `quoteccds.isActive = false`).

## Run locally
```
cp .env.example .env.dev   # fill in Mongo, Oracle test credentials, keys
npm install
npm run dev                # http://localhost:3040/onesify/opportunity/api/v1/health
npm test                   # in-memory Mongo + stubbed Oracle; nothing external is called
```

## Deploy on the OneSify server
The service runs next to the other product backends, as `/home/sslportal/onesify/opportunity`:
```
cd /home/sslportal/onesify
git clone https://github.com/Ragu29/opportunity.git opportunity
cd opportunity && npm ci --omit=dev
cp .env.example .env       # prod values; SSL_KEY_PATH / SSL_CERT_PATH -> the shared /home/sslportal/onesify/cert files
NODE_ENV=prod pm2 start index.js --name onesify-opportunity && pm2 save
```
After that:
- Pick a free `PORT` (check `pm2 ls` and the gateway config).
- Add a gateway rule `/onesify/opportunity/` → `localhost:<PORT>`, the same form as the other products.
- Add `opportunity/` to the root `/home/sslportal/onesify/.gitignore`.

### Moving CCD over
1. Deploy this service and test it against OSC test with the CCD config.
2. Copy existing CCD records: `SOURCE_MONGODB_DBNAME=<ccd db> node scripts/migrate-ccd.js` (dry run), then add `--apply`.
3. Switch crossconnect-domestic to the client behind a flag. Keep its old in-process code for one release as a fallback.
