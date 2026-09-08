# Personal bank import

The preview workflow prepares a dry-run for real bank statements. It never
connects to MongoDB and never modifies the existing development database. The
separate, explicitly confirmed load command is described below.

## Existing API assessment

The current `POST /api/import/transactions` endpoint is not suitable for real
bank data. It writes during parsing, deletes rows selected by a lossy compound
match before recreating them, and does not retain complete source provenance.
Its duplicate lookup also compares the original concept against `title`, even
though the stored title may be generated from a counterparty. Reimporting through
that endpoint could overwrite manual corrections or collapse legitimate equal
movements. The personal import therefore uses a separate dry-run workflow and
does not call the existing endpoint.

## Safety boundary

- The target database name is fixed to `fintrak_personal` in the manifest.
- The preview command contains no MongoDB client or write path.
- Real statements and generated previews belong under `data/`, which is ignored
  by Git. Do not commit them, test with them, or add them to Postman examples.
- The load command only reads a dedicated `PERSONAL_MONGODB_URI`; it never falls
  back to `MONGODB_URI`. The URI may omit a database component, but it may not
  name a different database. The loader explicitly connects to
  `fintrak_personal` and verifies that database name after connecting.
- The loader stores source records in the separate
  `personal_bank_transactions` collection. It does not call the existing API or
  write to its collections.
- On reimport, source fields are inserted only for a new `importId`. For an
  existing record, the loader adds missing provenance only. It never deletes or
  overwrites manual fields, category decisions, titles, tags, notes or review
  decisions.

## Build a preview

Copy `personal-import.manifest.example.json` outside version control, update the
file paths, and run:

```bash
pnpm --filter @fintrak/api preview:personal-import -- \
  --manifest data/personal-import.manifest.json \
  --output data/personal-import-preview.json
```

The manifest supports XLSX, XLS and CSV statements. Header detection covers the
common BBVA, Santander and Revolut exports. Each source explicitly supplies the
bank and logical account identity; file names are never used as account IDs.

The preview keeps:

- booking and value dates;
- signed amount and original currency;
- original concept and observations;
- bank, logical account and source row provenance;
- bank reference when supplied by the statement;
- running balance when supplied by the statement.
- transaction fees separately from the statement amount.

Pending and returned rows are reported in the source preview and excluded from
the proposed settled import. They are reconsidered on the next preview when the
bank marks them as completed.

## Duplicate handling

`importId` is deterministic. It uses the bank reference when present. Otherwise
it hashes the account, dates, signed amount, currency, original concept,
observations and movement type, plus an occurrence number.

Occurrence numbers preserve genuinely repeated equal transactions. When
overlapping exports contain the same rows, the preview merges equal occurrence
numbers and retains every source location. Repeated indistinguishable rows are
kept but flagged for review because no statement-only algorithm can prove
whether they are duplicates or separate legitimate movements.

## Classification and review rules

- `Navio Alvarez` is searched in both concept and observations and suggested as
  family education / nursery.
- Only a `Linea Directa` debit of exactly EUR 150.39 is suggested as family
  health insurance. Other Linea Directa charges are left for review.
- Cash withdrawals are tagged as possibly related to home works, but are not
  allocated without confirmation.
- Historical HP Instant Ink charges of EUR 7.99 are preserved. Charges of EUR
  1.79 are flagged until the effective date of the price change communicated on
  2026-09-06 is confirmed.
- Spotify, DAZN and YouTube remain subscription suggestions.
- Nabu Casa is tagged as Home Assistant remote access.
- Possible professional expenses are tagged and left for review.
- MyInvestor remains a documented missing source.

## Internal transfers and foreign exchange

Same-currency opposite amounts across different accounts within three days are
considered transfer candidates. A unique high-confidence pair is matched;
multiple or weaker candidates remain pending review.

Cross-currency candidates remain pending review. EUR and GBP are reconciled and
reported separately, and the approximate 1.17 exchange rate is never stored or
used as definitive.

## Load gate and execution

Do not build the load command until all source rows parse and each account is
reconciled. A non-zero balance reconciliation difference is a blocker. A missing
running-balance column is reported as unavailable rather than treated as a zero
difference; it requires a manual comparison with the statement opening and
closing balances before loading.

After rotating any credential that has been exposed, set the connection string
locally. Do not put it in the manifest, source files, Git, or chat. If its
password includes reserved URL characters, percent-encode them.

```bash
export PERSONAL_MONGODB_URI='mongodb+srv://...'
pnpm --filter @fintrak/api load:personal-import -- \
  --manifest data/personal-import.manifest.json \
  --confirm-load
```

The loader rebuilds the preview from the original files immediately before it
connects. It stops if parsing or reconciliation produces a blocker, creates a
unique `importId` index, and verifies that every source record exists after the
write. Pending-review records are stored with their review reasons; they are not
discarded or auto-resolved.
