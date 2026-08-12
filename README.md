# Route C - Production Sheets to MRP Service (Variant C3 - Fast & Browserless)

This service automatically generates and attaches production sheets to Sales Orders when confirmed in Odoo, notifying the MRP team. It uses **Route C, Variant C3**: browserless RPC data extraction, revision replaying, and in-process formula evaluation.

Implemented in **TypeScript on Node.js** (ported 1:1 from the original Python service, which is kept for reference under `legacy-python/`).

## Architecture & Features

- **No Browser / Playwright Dependency**: Reads `sale.order.spreadsheet` base data/snapshots and `spreadsheet.revision` logs directly over RPC.
- **Revision Replay**: Chains `spreadsheet.revision` records (`parent_revision_id`) and applies `UPDATE_CELL` commands to get live cell values.
- **In-process evaluation**: A self-contained o-spreadsheet engine (unsquisher → tokenizer → parser → evaluator) resolves every formula in Node, so no Excel and no formula recalculation step is needed. It covers the functions these calculators use — `IF`/`IFERROR`, `AND`/`OR`/`NOT`, `SUM`/`MAX`/`MIN`/`AVERAGE`/`COUNT`/`PRODUCT`/`ABS`/`INT`, `ROUND`/`ROUNDUP`/`ROUNDDOWN`, `FLOOR`/`CEILING`, `SQRT`, `SIN`/`COS`/`TAN`/`ASIN`/`ACOS`/`ATAN`/`PI`/`RADIANS`/`DEGREES`, `INDEX`/`MATCH`, `ADDRESS`, `TODAY` and the `IS*` predicates — plus embedded error literals (`#REF!`), omitted arguments (`ROUNDUP(A1/B1,)`) and cell number formats. Anything it still does not know is logged as `Unimplemented spreadsheet function(s) -> #NAME?`, because one missing function turns every dependent cell into `#NAME?`.
- **Transport**: Odoo JSON-RPC over `fetch` — no native or CommonJS dependency, so the same code runs on a server and in a serverless function.
- **Output**: `productie.xlsx`, containing **ONLY** the print sheets — every sheet whose name **starts with `Afdrukpagina`**, matched case-insensitively (`Afdrukpagina 1`, `afdrukpagina 2`, `AFDRUKPAGINA 3` all qualify) — written with ExcelJS including styles, cell borders, merges and row/column dimensions. Borders and fills are read from the workbook's shared tables and applied to empty cells too, so the table structure comes out as it looks in Odoo rather than as bare floating values. If no sheet matches, **nothing is sent**: no workbook is attached and no chatter message is posted; the skip is logged as a warning.
- **Images**: sheet figures tagged `image` are placed in the workbook at their o-spreadsheet anchor (cell + pixel offset) and original size. The bytes come from `ir.attachment` over RPC — no session cookie needed — and Odoo's WebP is converted to PNG in-process so it renders in every Excel version. A figure whose image cannot be resolved is skipped and logged; see *Missing images* below.
- **No native dependencies**: pure JavaScript end to end, which is what lets the identical code run on a container host and inside a Netlify function. The WebP decoder is WebAssembly, and its binary is inlined into the Netlify bundle at build time.
- **Validation**: Scans the print sheets for unexpected formula errors and logs them before completing.

## Project Layout

```
src/
  app.ts                  Express webhook endpoint + background order processing
  odooRpc.ts              Odoo JSON-RPC client (login / execute_kw helpers)
  calculator.ts           C3 engine: RPC fetch, revision replay, validation
  processOrder.ts         The order worker, shared by every entry point
  config.ts               Environment configuration
  logger.ts               Minimal stdout logger
  render/
    model.ts              Evaluated view of the workbook (values + styles + figures)
    images.ts             Resolves figure images from ir.attachment; WebP -> PNG
    png.ts                Minimal RGBA -> PNG encoder (Node zlib, no dependency)
    xlsx.ts               ExcelJS emitter
  spreadsheet/
    refs.ts               A1 reference parsing and column-letter helpers
    values.ts             Value coercion, comparison and rounding rules
    tokenizer.ts          Formula tokenizer
    parser.ts             Recursive-descent expression parser
    unsquish.ts           o-spreadsheet (19.1+) squished-cell delta decoder
    evaluator.ts          Lazy, memoised formula evaluator with cycle detection
    book.ts               Builds the evaluable book from Odoo's spreadsheet JSON
netlify/functions/        Netlify entry points (webhook, controller, health)
legacy-python/            Original Python implementation (reference only)
```

## Configuration in Odoo

1. **Server Action**:
   - Model: `Sales Order`
   - Type: `Send Webhook Notification`
   - URL: Your service's endpoint URL (e.g. `https://your-service.com/webhook`)
   - Fields to send: `name`, `partner_id`, `spreadsheet_id`
2. **Automation Rule**:
   - Model: `sale.order`
   - Trigger: **On save**
   - Condition: `state == 'sale'`
   - Action: The Server Action created in Step 1.
3. **API User & Access Group**: Create a dedicated Odoo API user + API key. Ensure this user has `base.group_system` (Settings/Administration) access rights in Odoo so it can query `spreadsheet.revision`.

## Setup & Running the Service

Requires **Node.js 18+**. No system packages needed.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set environment variables in `.env` (copy `.env.example`):
   - `ODOO_URL`
   - `ODOO_DB`
   - `ODOO_API_USER`
   - `ODOO_API_KEY`
   - `MRP_NOTIFY_EMAIL` (optional, default `e.scholten@fkm-lichtstraten.nl`) —
     the one person the production-sheet message is addressed to. Matched on the
     partner's email rather than an id, so it survives a move to another
     database. If no partner has that address the message is still posted, with
     the attachment, but notifies nobody and an error is logged.
   - `PORT` (optional, default `8000`)
3. Build and run the web service:
   ```bash
   npm run build
   npm start
   ```
   During development, `npm run dev` recompiles on change and `npm run typecheck` type-checks without emitting.

## Deployment

Two supported shapes:

- **Container host** (Render, Fly.io, Railway, a VPS) — runs the Express server as a
  normal long-lived process, with synchronous request/response handling.
- **Netlify** — runs as a background function. See below.

Build and run anywhere Docker runs:

```bash
docker build -t fkm-connector .
docker run -p 8000:8000 --env-file .env fkm-connector
```

Ready-made configs are included:

| Host | File | Deploy |
| --- | --- | --- |
| Render | `render.yaml` | New > Blueprint > pick the repo, then set env vars in the dashboard |
| Fly.io | `fly.toml` | `fly launch --no-deploy`, `fly secrets set ...`, `fly deploy` |

Any Docker host works the same way (Railway, DigitalOcean App Platform, ECS, a plain VPS).
Point the Odoo Server Action's webhook URL at `https://<your-host>/webhook`.

### Netlify

The webhook is a **background function** (`netlify/functions/webhook.mts`,
`config = { background: true, path: '/webhook' }`). Netlify answers the caller with an
empty `202` immediately and lets the worker run for up to 15 minutes — a normal function
would be frozen the moment it returned.

`netlify/functions/process-order.mts` is a *synchronous* controller at
`POST /api/process-order`; it returns the processing result, so it is bound by Netlify's
60-second function limit.

#### Option A — manual upload (drag & drop)

```bash
npm run build:netlify
```

That produces `netlify-deploy/` (and you can zip it). The functions are pre-bundled with
esbuild — every dependency inlined — so Netlify runs no build step and needs no
`node_modules`.

1. Netlify → **Add new site → Deploy manually**, drop the `netlify-deploy` folder in.
2. **Site configuration → Environment variables**, add `ODOO_URL`, `ODOO_DB`,
   `ODOO_API_USER` and `ODOO_API_KEY`.
3. **Redeploy** — environment variables are only read at invocation, but a redeploy is the
   reliable way to be sure they are picked up.

Re-run `npm run build:netlify` and drop the folder again for every update.

#### Option B — Git deploy (recommended for ongoing work)

```bash
npm i -g netlify-cli     # needs Node 20+
netlify init             # or: netlify link
netlify env:set ODOO_URL https://your-company.odoo.com
netlify env:set ODOO_DB your-database-name
netlify env:set ODOO_API_USER api-user@example.com
netlify env:set ODOO_API_KEY your-api-key
netlify deploy --prod
```

Then point the Odoo Server Action at `https://<site>.netlify.app/webhook`.
`GET /health` confirms the deploy is live.

**Caveats.** The webhook always answers `202` with an empty body, so the JSON status
replies (`ignored` / `error`) exist only in the function logs — check them in the Netlify
dashboard when debugging. Netlify also retries a failing invocation after 1 and 2 minutes,
so a hard failure can post the sheets more than once.

## Missing images

A figure stores only a URL (`/web/image/743`); the picture itself is an
`ir.attachment` row. Two things go wrong with that in practice, and both show up
as gaps in the generated sheet **and** as broken-image placeholders in Odoo
itself:

- **The attachment is gone.** Deleting it, or importing a workbook from another
  database, leaves the figure pointing at nothing. A workbook copied from
  another database is easy to spot: its figures reference attachment ids higher
  than the ids that exist locally.
- **The id has been reused.** Attachment ids are a plain sequence, so a deleted
  image's id is later handed to an unrelated record — a spreadsheet snapshot, a
  CSS bundle, a JS asset. The service checks the mimetype and refuses anything
  that is not `image/*`; without that check those bytes would be embedded as a
  corrupt picture.

Neither case fails the order. Each run logs one summary line:

```
WARNING:images:Figure images: 3/17 resolved. 8 attachment(s) no longer exist (746, 747, …);
6 id(s) now belong to a non-image record — id reuse, skipped (#755 (text/css, "web.report_assets_common.min.css"); …)
```

If that line reports few resolved images, the images are missing in Odoo and
have to be re-inserted into the spreadsheet there — the connector renders what
the database still has.

## Endpoint

`POST /webhook` accepts the Odoo webhook payload and responds immediately. On Netlify the
response is always an empty `202` and these bodies appear in the function logs instead:

| Response | Meaning |
| --- | --- |
| `{"status":"processing_started"}` | Accepted; the order is processed in the background |
| `{"status":"ignored","reason":"Not a sale.order"}` | `_model` was not `sale.order` |
| `{"status":"ignored","reason":"Order state '…' is not 'sale'"}` | Payload carried a non-confirmed state |
| `{"status":"error","reason":"Missing _id"}` | No order id in the payload |

The order is re-read over RPC and skipped unless its state is `sale`.
# FKM-Test-js
