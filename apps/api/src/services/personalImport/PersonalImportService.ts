import { createHash } from 'node:crypto';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type {
  AccountPreview,
  ClassificationSuggestion,
  CurrencyReconciliation,
  ImportSourceConfig,
  NormalizedBankTransaction,
  PersonalImportManifest,
  PersonalImportPreview,
  ReviewReason,
  SourceLocation,
  SourcePreview,
  SupportedCurrency,
} from './types';

type Cell = string | number | boolean | Date | null | undefined;

interface ParsedRow {
  bankReference?: string;
  bookingDate: string;
  valueDate?: string;
  amount: number;
  fee?: number;
  currency: SupportedCurrency;
  originalConcept: string;
  originalObservations?: string;
  movementType?: string;
  balanceAfter?: number;
  provenance: SourceLocation;
}

interface HeaderMap {
  date: number;
  description: number;
  amount: number;
  fee?: number;
  valueDate?: number;
  currency?: number;
  observations?: number;
  movementType?: number;
  balance?: number;
  bankReference?: number;
  status?: number;
}

const HEADER_ALIASES: Record<keyof HeaderMap, string[]> = {
  date: [
    'fecha',
    'fecha operacion',
    'fecha de operacion',
    'booking date',
    'completed date',
    'completed',
    'fecha de finalizacion',
  ],
  valueDate: [
    'f valor',
    'fecha valor',
    'value date',
    'started date',
    'fecha de inicio',
  ],
  description: [
    'concepto',
    'descripcion',
    'description',
    'detalle',
    'merchant',
  ],
  amount: ['importe', 'importe eur', 'cantidad', 'amount', 'monto'],
  fee: ['comision', 'fee'],
  currency: ['divisa', 'moneda', 'currency'],
  observations: [
    'observaciones',
    'observacion',
    'notes',
    'note',
    'reference',
    'referencia',
  ],
  movementType: ['movimiento', 'tipo', 'type', 'transaction type'],
  balance: ['saldo', 'disponible', 'balance', 'running balance'],
  bankReference: [
    'transaction id',
    'transaction_id',
    'id transaccion',
    'referencia bancaria',
    'bank reference',
  ],
  status: ['state', 'estado', 'status'],
};

const TRANSFER_PATTERN =
  /\b(transfer|transferencia|transferir|traspaso|recarga|recargas|top up|cambio)\b/;

const PROFESSIONAL_TERMS = [
  'amazon web services',
  'aws',
  'github',
  'openai',
  'anthropic',
  'jetbrains',
  'vercel',
  'cloudflare',
  'digitalocean',
];

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const normalizeText = (value: Cell): string =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const exactHeaderMatch = (value: Cell, aliases: string[]): boolean => {
  const normalized = normalizeText(value);
  return aliases.some((alias) => normalized === alias);
};

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const formatDate = (year: number, month: number, day: number): string => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('Invalid calendar date');
  }
  return date.toISOString().slice(0, 10);
};

const parseDate = (value: Cell): string => {
  if (value instanceof Date) {
    return formatDate(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate()
    );
  }

  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) throw new Error(`Invalid Excel date: ${value}`);
    return formatDate(parsed.y, parsed.m, parsed.d);
  }

  const text = String(value ?? '').trim();
  const dayFirst = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dayFirst) {
    return formatDate(
      Number(dayFirst[3]),
      Number(dayFirst[2]),
      Number(dayFirst[1])
    );
  }

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Unsupported date: ${text}`);
  }
  return formatDate(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate()
  );
};

const parseAmount = (value: Cell): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = String(value ?? '')
    .trim()
    .replace(/[€£$\s]/g, '');
  const negativeParentheses = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, '');

  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  if (comma > dot) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (dot > comma && comma !== -1) {
    text = text.replace(/,/g, '');
  } else if (comma !== -1) {
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid amount: ${value}`);
  return negativeParentheses ? -Math.abs(parsed) : parsed;
};

const parseCurrency = (
  value: Cell,
  defaultCurrency?: SupportedCurrency
): SupportedCurrency => {
  const normalized = String(value ?? defaultCurrency ?? '')
    .trim()
    .toUpperCase();
  if (normalized === '€') return 'EUR';
  if (normalized === '£') return 'GBP';
  if (normalized === '$') return 'USD';
  if (['EUR', 'GBP', 'USD'].includes(normalized)) {
    return normalized as SupportedCurrency;
  }
  throw new Error(
    `Unsupported or missing currency: ${normalized || '(blank)'}`
  );
};

const findHeader = (rows: Cell[][]): { index: number; map: HeaderMap } => {
  let best: { index: number; map: Partial<HeaderMap>; score: number } | null =
    null;

  const candidateRows = rows.slice(0, 40);
  for (let index = 0; index < candidateRows.length; index++) {
    const row = candidateRows[index];
    const map: Partial<HeaderMap> = {};
    for (const key of Object.keys(HEADER_ALIASES) as (keyof HeaderMap)[]) {
      const column = row.findIndex((cell) =>
        exactHeaderMatch(cell, HEADER_ALIASES[key])
      );
      if (column !== -1) map[key] = column;
    }
    const required = ['date', 'description', 'amount'] as const;
    const score = Object.keys(map).length;
    if (
      required.every((key) => map[key] !== undefined) &&
      (!best || score > best.score)
    ) {
      best = { index, map, score };
    }
  }

  if (!best) {
    throw new Error(
      'No supported header row found (date, description and amount are required)'
    );
  }
  return { index: best.index, map: best.map as HeaderMap };
};

const readCell = (row: Cell[], column?: number): Cell =>
  column === undefined ? undefined : row[column];

const parseSource = (
  buffer: Buffer,
  source: ImportSourceConfig,
  since: string
): { transactions: ParsedRow[]; preview: SourcePreview } => {
  const isCsv = path.extname(source.path).toLowerCase() === '.csv';
  const workbook = isCsv
    ? XLSX.read(buffer.toString('utf8'), {
        type: 'string',
        cellDates: true,
        raw: true,
      })
    : XLSX.read(buffer, {
        type: 'buffer',
        cellDates: true,
        raw: true,
      });
  const errors: string[] = [];
  const transactions: ParsedRow[] = [];
  let rowsRead = 0;
  let rowsBeforeCutoff = 0;
  let rowsExcluded = 0;
  const excludedByStatus: Record<string, number> = {};

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
      header: 1,
      defval: null,
      raw: true,
    });
    if (!rows.some((row) => row.some((cell) => cell !== null))) continue;

    let header: { index: number; map: HeaderMap };
    try {
      header = findHeader(rows);
    } catch (error) {
      errors.push(
        `${sheetName}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      continue;
    }

    rows.slice(header.index + 1).forEach((row, relativeIndex) => {
      const rowNumber = header.index + relativeIndex + 2;
      const hasContent = row.some(
        (cell) => cell !== null && String(cell).trim() !== ''
      );
      if (!hasContent) return;
      rowsRead++;

      try {
        const rawStatus = String(readCell(row, header.map.status) ?? '').trim();
        const status = normalizeText(rawStatus);
        if (
          status &&
          !['completed', 'completado', 'settled', 'contabilizado'].includes(
            status
          )
        ) {
          rowsExcluded++;
          excludedByStatus[rawStatus] = (excludedByStatus[rawStatus] ?? 0) + 1;
          return;
        }
        const originalConcept = String(
          readCell(row, header.map.description) ?? ''
        ).trim();
        if (!originalConcept) throw new Error('Missing description');
        const bookingDate = parseDate(readCell(row, header.map.date));
        if (bookingDate < since) {
          rowsBeforeCutoff++;
          return;
        }
        const observations = String(
          readCell(row, header.map.observations) ?? ''
        ).trim();
        const movementType = String(
          readCell(row, header.map.movementType) ?? ''
        ).trim();
        const bankReference = String(
          readCell(row, header.map.bankReference) ?? ''
        ).trim();
        const rawBalance = readCell(row, header.map.balance);
        const rawFee = readCell(row, header.map.fee);

        transactions.push({
          ...(bankReference && { bankReference }),
          bookingDate,
          ...(header.map.valueDate !== undefined &&
            readCell(row, header.map.valueDate) !== null &&
            readCell(row, header.map.valueDate) !== undefined &&
            String(readCell(row, header.map.valueDate)).trim() !== '' && {
              valueDate: parseDate(readCell(row, header.map.valueDate)),
            }),
          amount: roundMoney(parseAmount(readCell(row, header.map.amount))),
          ...(rawFee !== undefined &&
            rawFee !== null &&
            String(rawFee).trim() !== '' && {
              fee: roundMoney(Math.abs(parseAmount(rawFee))),
            }),
          currency: parseCurrency(
            readCell(row, header.map.currency),
            source.defaultCurrency
          ),
          originalConcept,
          ...(observations && { originalObservations: observations }),
          ...(movementType && { movementType }),
          ...(rawBalance !== undefined &&
            rawBalance !== null &&
            String(rawBalance).trim() !== '' && {
              balanceAfter: roundMoney(parseAmount(rawBalance)),
            }),
          provenance: {
            sourceId: source.sourceId,
            fileName: path.basename(source.path),
            sheetName,
            rowNumber,
          },
        });
      } catch (error) {
        errors.push(
          `${sheetName} row ${rowNumber}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    });
  }

  return {
    transactions,
    preview: {
      sourceId: source.sourceId,
      fileName: path.basename(source.path),
      bank: source.bank,
      accountId: source.accountId,
      accountName: source.accountName,
      rowsRead,
      rowsAccepted: transactions.length,
      rowsBeforeCutoff,
      rowsExcluded,
      excludedByStatus,
      errors,
    },
  };
};

const sourceFingerprint = (
  source: ImportSourceConfig,
  row: ParsedRow
): string => {
  const identity = row.bankReference
    ? `reference|${row.bankReference}`
    : [
        row.bookingDate,
        row.valueDate ?? '',
        row.amount.toFixed(2),
        row.fee?.toFixed(2) ?? '',
        row.currency,
        normalizeText(row.originalConcept),
        normalizeText(row.originalObservations),
        normalizeText(row.movementType),
      ].join('|');
  return hash(
    `personal-import-v1|${source.bank}|${source.accountId}|${identity}`
  );
};

const classify = (transaction: ParsedRow): ClassificationSuggestion => {
  const text = normalizeText(
    `${transaction.originalConcept} ${transaction.originalObservations ?? ''}`
  );
  const tags: string[] = [];
  const reviewReasons: ReviewReason[] = [];
  let category: string | undefined;
  let note: string | undefined;

  if (text.includes('navio alvarez')) {
    category = 'education';
    tags.push('family', 'nursery');
  }

  if (text.includes('linea directa')) {
    if (
      transaction.amount < 0 &&
      Math.abs(transaction.amount + 150.39) < 0.005
    ) {
      category = 'health';
      tags.push('family', 'health-insurance');
      note = 'Confirmed policy for spouse and two children.';
    } else {
      reviewReasons.push('linea_directa_other_charge');
    }
  }

  if (/\b(cajero|atm|cash withdrawal|retirada efectivo)\b/.test(text)) {
    tags.push('cash', 'possible-home-works');
    reviewReasons.push('cash_use_unconfirmed');
  }

  if (text.includes('hp instant ink')) {
    category = 'subscriptions';
    tags.push('hp-instant-ink');
    if (Math.abs(transaction.amount + 1.79) < 0.005) {
      reviewReasons.push('hp_instant_ink_effective_date_unconfirmed');
      note =
        'The new EUR 1.79 monthly price was communicated on 2026-09-06; the effective charge date remains unconfirmed.';
    } else if (Math.abs(transaction.amount + 7.99) < 0.005) {
      note = 'Historical EUR 7.99 charge; preserve as reported.';
    }
  }

  if (/\b(spotify|spotifyes|dazn|youtube)\b/.test(text)) {
    category = 'subscriptions';
  }

  if (text.includes('nabu casa')) {
    category = 'subscriptions';
    tags.push('home-assistant', 'remote-access');
  }

  if (PROFESSIONAL_TERMS.some((term) => ` ${text} `.includes(` ${term} `))) {
    tags.push('possible-professional');
    reviewReasons.push('possible_professional_expense');
  }

  return {
    ...(category && { category }),
    tags,
    reviewReasons,
    ...(note && { note }),
  };
};

const normalizeTransactions = (
  rowsBySource: Array<{
    source: ImportSourceConfig;
    rows: ParsedRow[];
  }>
): NormalizedBankTransaction[] => {
  const merged = new Map<string, NormalizedBankTransaction>();

  for (const { source, rows } of rowsBySource) {
    const occurrences = new Map<string, number>();
    for (const row of rows) {
      const fingerprint = sourceFingerprint(source, row);
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      const importId = hash(`${fingerprint}|occurrence|${occurrence}`);
      const existing = merged.get(importId);
      if (existing) {
        existing.provenance.push(row.provenance);
        continue;
      }

      merged.set(importId, {
        importId,
        fingerprint,
        occurrence,
        ...(row.bankReference && { bankReference: row.bankReference }),
        bank: source.bank,
        accountId: source.accountId,
        accountName: source.accountName,
        bookingDate: row.bookingDate,
        ...(row.valueDate && { valueDate: row.valueDate }),
        amount: row.amount,
        ...(row.fee !== undefined && { fee: row.fee }),
        currency: row.currency,
        originalConcept: row.originalConcept,
        ...(row.originalObservations && {
          originalObservations: row.originalObservations,
        }),
        ...(row.movementType && { movementType: row.movementType }),
        ...(row.balanceAfter !== undefined && {
          balanceAfter: row.balanceAfter,
        }),
        provenance: [row.provenance],
        classification: classify(row),
      });
    }
  }

  const transactions = [...merged.values()];
  const fingerprintCounts = new Map<string, number>();
  transactions.forEach((transaction) => {
    fingerprintCounts.set(
      transaction.fingerprint,
      (fingerprintCounts.get(transaction.fingerprint) ?? 0) + 1
    );
  });
  transactions.forEach((transaction) => {
    if ((fingerprintCounts.get(transaction.fingerprint) ?? 0) > 1) {
      transaction.classification.reviewReasons.push('ambiguous_duplicate');
    }
  });
  const relaxedMatches = new Map<string, NormalizedBankTransaction[]>();
  transactions.forEach((transaction) => {
    const key = [
      transaction.accountId,
      transaction.bookingDate,
      transaction.amount.toFixed(2),
      transaction.currency,
    ].join('|');
    relaxedMatches.set(key, [...(relaxedMatches.get(key) ?? []), transaction]);
  });
  relaxedMatches.forEach((matches) => {
    if (matches.length > 1) {
      matches.forEach((transaction) =>
        transaction.classification.reviewReasons.push('ambiguous_duplicate')
      );
    }
  });
  return transactions;
};

const daysApart = (left: string, right: string): number =>
  Math.abs(
    (new Date(`${left}T00:00:00Z`).getTime() -
      new Date(`${right}T00:00:00Z`).getTime()) /
      86_400_000
  );

const hasExplicitTransferTerm = (
  transaction: NormalizedBankTransaction
): boolean => {
  const text = normalizeText(
    `${transaction.originalConcept} ${transaction.originalObservations ?? ''} ${transaction.movementType ?? ''}`
  );
  return TRANSFER_PATTERN.test(text);
};

const isRevolutTopUp = (transaction: NormalizedBankTransaction): boolean =>
  transaction.bank.toLowerCase() === 'revolut' &&
  transaction.amount > 0 &&
  normalizeText(transaction.movementType).includes('recarga');

const transferMatchId = (
  left: NormalizedBankTransaction,
  right: NormalizedBankTransaction
): string => hash([left.importId, right.importId].sort().join('|'));

export const detectInternalTransfers = (
  transactions: NormalizedBankTransaction[]
): void => {
  const candidateMap = new Map<
    string,
    Array<{ counterpart: NormalizedBankTransaction; score: number }>
  >();
  const crossCurrencyCandidateMap = new Map<
    string,
    NormalizedBankTransaction[]
  >();

  for (let leftIndex = 0; leftIndex < transactions.length; leftIndex++) {
    const left = transactions[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < transactions.length;
      rightIndex++
    ) {
      const right = transactions[rightIndex];
      if (
        left.accountId === right.accountId ||
        Math.sign(left.amount) === Math.sign(right.amount)
      ) {
        continue;
      }
      const dateDistance = daysApart(left.bookingDate, right.bookingDate);
      if (dateDistance > 3) continue;
      const bothExplicitTransfers =
        hasExplicitTransferTerm(left) && hasExplicitTransferTerm(right);
      if (!bothExplicitTransfers) continue;

      if (
        left.currency === right.currency &&
        Math.abs(Math.abs(left.amount) - Math.abs(right.amount)) < 0.005
      ) {
        const score =
          0.45 +
          (dateDistance === 0 ? 0.35 : dateDistance === 1 ? 0.25 : 0.1) +
          0.2;
        candidateMap.set(left.importId, [
          ...(candidateMap.get(left.importId) ?? []),
          { counterpart: right, score },
        ]);
        candidateMap.set(right.importId, [
          ...(candidateMap.get(right.importId) ?? []),
          { counterpart: left, score },
        ]);
      } else if (
        left.currency !== right.currency &&
        dateDistance <= 1 &&
        ((isRevolutTopUp(left) && right.amount < 0) ||
          (isRevolutTopUp(right) && left.amount < 0))
      ) {
        crossCurrencyCandidateMap.set(left.importId, [
          ...(crossCurrencyCandidateMap.get(left.importId) ?? []),
          right,
        ]);
        crossCurrencyCandidateMap.set(right.importId, [
          ...(crossCurrencyCandidateMap.get(right.importId) ?? []),
          left,
        ]);
      }
    }
  }

  const handled = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.internalTransfer || handled.has(transaction.importId)) {
      continue;
    }
    const candidates = candidateMap.get(transaction.importId) ?? [];
    if (candidates.length === 0) continue;
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    const reverseCandidates = candidateMap.get(best.counterpart.importId) ?? [];
    const isUniquePair =
      candidates.length === 1 &&
      reverseCandidates.length === 1 &&
      reverseCandidates[0].counterpart.importId === transaction.importId;
    if (!isUniquePair) {
      transaction.classification.reviewReasons.push(
        'internal_transfer_ambiguous'
      );
      continue;
    }
    const status = best.score >= 0.9 ? 'matched' : 'pending_review';
    const matchId = transferMatchId(transaction, best.counterpart);
    const reason =
      status === 'matched'
        ? 'Unique same-currency opposite-amount match within one day.'
        : 'Multiple or lower-confidence same-currency candidates.';

    transaction.internalTransfer = {
      matchId,
      counterpartImportId: best.counterpart.importId,
      status,
      reason,
    };
    best.counterpart.internalTransfer = {
      matchId,
      counterpartImportId: transaction.importId,
      status,
      reason,
    };
    if (status === 'pending_review') {
      transaction.classification.reviewReasons.push(
        'internal_transfer_ambiguous'
      );
      best.counterpart.classification.reviewReasons.push(
        'internal_transfer_ambiguous'
      );
    }
    handled.add(transaction.importId);
    handled.add(best.counterpart.importId);
  }

  for (const transaction of transactions) {
    if (transaction.internalTransfer || handled.has(transaction.importId)) {
      continue;
    }
    const candidates =
      crossCurrencyCandidateMap.get(transaction.importId) ?? [];
    if (candidates.length === 0) continue;
    const counterpart = candidates[0];
    const reverseCandidates =
      crossCurrencyCandidateMap.get(counterpart.importId) ?? [];
    const isUniquePair =
      candidates.length === 1 &&
      reverseCandidates.length === 1 &&
      reverseCandidates[0].importId === transaction.importId;
    transaction.classification.reviewReasons.push(
      'internal_transfer_cross_currency'
    );
    if (!isUniquePair || handled.has(counterpart.importId)) continue;

    const matchId = transferMatchId(transaction, counterpart);
    const reason =
      'Possible cross-currency internal transfer; no approximate FX rate was used.';
    transaction.internalTransfer = {
      matchId,
      counterpartImportId: counterpart.importId,
      status: 'pending_review',
      reason,
    };
    counterpart.internalTransfer = {
      matchId,
      counterpartImportId: transaction.importId,
      status: 'pending_review',
      reason,
    };
    counterpart.classification.reviewReasons.push(
      'internal_transfer_cross_currency'
    );
    handled.add(transaction.importId);
    handled.add(counterpart.importId);
  }
};

const reconcileCurrency = (
  transactions: NormalizedBankTransaction[],
  currency: SupportedCurrency
): CurrencyReconciliation => {
  const selected = transactions
    .filter((transaction) => transaction.currency === currency)
    .sort(
      (left, right) =>
        left.bookingDate.localeCompare(right.bookingDate) ||
        left.importId.localeCompare(right.importId)
    );
  const debits = roundMoney(
    selected
      .filter((transaction) => transaction.amount < 0)
      .reduce((total, transaction) => total + transaction.amount, 0)
  );
  const credits = roundMoney(
    selected
      .filter((transaction) => transaction.amount >= 0)
      .reduce((total, transaction) => total + transaction.amount, 0)
  );
  const fees = roundMoney(
    selected.reduce((total, transaction) => total + (transaction.fee ?? 0), 0)
  );
  const balanceRowsBySource = new Map<string, NormalizedBankTransaction[]>();
  selected
    .filter((transaction) => transaction.balanceAfter !== undefined)
    .forEach((transaction) => {
      transaction.provenance.forEach((location) => {
        balanceRowsBySource.set(location.sourceId, [
          ...(balanceRowsBySource.get(location.sourceId) ?? []),
          transaction,
        ]);
      });
    });
  const primaryBalanceSource = [...balanceRowsBySource.entries()].sort(
    (left, right) => right[1].length - left[1].length
  )[0];
  const balanceRows = primaryBalanceSource?.[1];
  const balanceSourceId = primaryBalanceSource?.[0];
  let inferredOpeningBalance: number | null = null;
  let closingBalance: number | null = null;
  if (balanceRows?.length) {
    balanceRows.sort((left, right) => {
      const leftRow = left.provenance.find(
        (location) => location.sourceId === balanceSourceId
      )?.rowNumber;
      const rightRow = right.provenance.find(
        (location) => location.sourceId === balanceSourceId
      )?.rowNumber;
      return (leftRow ?? 0) - (rightRow ?? 0);
    });
    const first = balanceRows[0];
    const last = balanceRows[balanceRows.length - 1];
    const statementIsAscending = first.bookingDate <= last.bookingDate;
    const openingTransaction = statementIsAscending ? first : last;
    const closingTransaction = statementIsAscending ? last : first;
    const openingCashImpact =
      openingTransaction.amount - (openingTransaction.fee ?? 0);
    inferredOpeningBalance = roundMoney(
      (openingTransaction.balanceAfter as number) - openingCashImpact
    );
    closingBalance = closingTransaction.balanceAfter as number;
  }
  const net = roundMoney(debits + credits);
  const netAfterFees = roundMoney(net - fees);
  const reconciliationDifference =
    inferredOpeningBalance !== null && closingBalance !== null
      ? roundMoney(closingBalance - inferredOpeningBalance - netAfterFees)
      : null;

  return {
    currency,
    transactionCount: selected.length,
    debitCount: selected.filter((transaction) => transaction.amount < 0).length,
    creditCount: selected.filter((transaction) => transaction.amount >= 0)
      .length,
    debits,
    credits,
    fees,
    net,
    netAfterFees,
    inferredOpeningBalance,
    closingBalance,
    reconciliationDifference,
  };
};

const reconcileAccounts = (
  transactions: NormalizedBankTransaction[]
): AccountPreview[] => {
  const accounts = new Map<string, NormalizedBankTransaction[]>();
  transactions.forEach((transaction) => {
    accounts.set(transaction.accountId, [
      ...(accounts.get(transaction.accountId) ?? []),
      transaction,
    ]);
  });

  return [...accounts.values()].map((accountTransactions) => {
    const first = accountTransactions[0];
    const currencies = [
      ...new Set(
        accountTransactions.map((transaction) => transaction.currency)
      ),
    ].sort();
    return {
      accountId: first.accountId,
      accountName: first.accountName,
      bank: first.bank,
      currencies: currencies.map((currency) =>
        reconcileCurrency(accountTransactions, currency)
      ),
    };
  });
};

export const validateManifest = (
  manifest: PersonalImportManifest
): PersonalImportManifest => {
  if (manifest.targetDatabase !== 'fintrak_personal') {
    throw new Error('targetDatabase must be exactly "fintrak_personal"');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.since)) {
    throw new Error('since must use YYYY-MM-DD format');
  }
  parseDate(manifest.since);
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new Error('At least one source is required');
  }
  const sourceIds = new Set<string>();
  manifest.sources.forEach((source) => {
    if (
      !source.path ||
      !source.sourceId ||
      !source.bank ||
      !source.accountId ||
      !source.accountName
    ) {
      throw new Error(
        'Every source requires path, sourceId, bank and account fields'
      );
    }
    if (sourceIds.has(source.sourceId)) {
      throw new Error(`Duplicate sourceId: ${source.sourceId}`);
    }
    sourceIds.add(source.sourceId);
  });
  return manifest;
};

export const buildPersonalImportPreview = (
  manifest: PersonalImportManifest,
  fileBuffers: Map<string, Buffer>,
  generatedAt = new Date().toISOString()
): PersonalImportPreview => {
  validateManifest(manifest);
  const sourcePreviews: SourcePreview[] = [];
  const rowsBySource: Array<{
    source: ImportSourceConfig;
    rows: ParsedRow[];
  }> = [];

  for (const source of manifest.sources) {
    const buffer = fileBuffers.get(source.sourceId);
    if (!buffer) throw new Error(`Missing file buffer for ${source.sourceId}`);
    const parsed = parseSource(buffer, source, manifest.since);
    sourcePreviews.push(parsed.preview);
    rowsBySource.push({ source, rows: parsed.transactions });
  }

  const transactions = normalizeTransactions(rowsBySource).sort(
    (left, right) =>
      left.bookingDate.localeCompare(right.bookingDate) ||
      left.accountId.localeCompare(right.accountId) ||
      left.importId.localeCompare(right.importId)
  );
  detectInternalTransfers(transactions);
  const accounts = reconcileAccounts(transactions);
  const blockers: string[] = [];
  const warnings = [
    'MyInvestor is not included because its statement has not been provided.',
    'GBP totals remain in GBP. No approximate EUR/GBP rate is treated as definitive.',
    'Manual classifications must be stored separately from source fields during loading.',
  ];
  sourcePreviews.forEach((source) => {
    if (source.errors.length > 0) {
      blockers.push(
        `${source.sourceId} has ${source.errors.length} unparsed row or sheet error(s).`
      );
    }
    if (source.rowsAccepted === 0) {
      blockers.push(`${source.sourceId} has no accepted transactions.`);
    }
  });
  accounts.forEach((account) => {
    account.currencies.forEach((currency) => {
      if (
        currency.reconciliationDifference !== null &&
        Math.abs(currency.reconciliationDifference) >= 0.01
      ) {
        blockers.push(
          `${account.accountId} ${currency.currency} does not reconcile by ${currency.reconciliationDifference.toFixed(2)}.`
        );
      } else if (currency.reconciliationDifference === null) {
        blockers.push(
          `${account.accountId} ${currency.currency} has no usable running balance; opening and closing balances must be checked manually.`
        );
      }
    });
  });

  const byReason: Partial<Record<ReviewReason, number>> = {};
  transactions.forEach((transaction) => {
    transaction.classification.reviewReasons = [
      ...new Set(transaction.classification.reviewReasons),
    ];
    transaction.classification.reviewReasons.forEach((reason) => {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    });
  });
  const transferPairs = new Map<string, 'matched' | 'pending_review'>();
  transactions.forEach((transaction) => {
    if (transaction.internalTransfer) {
      transferPairs.set(
        transaction.internalTransfer.matchId,
        transaction.internalTransfer.status
      );
    }
  });

  return {
    generatedAt,
    since: manifest.since,
    targetDatabase: manifest.targetDatabase,
    writePerformed: false,
    readyForLoad: blockers.length === 0,
    blockers,
    warnings,
    sources: sourcePreviews,
    accounts,
    review: {
      transactionCount: transactions.filter(
        (transaction) => transaction.classification.reviewReasons.length > 0
      ).length,
      internalTransfersMatched: [...transferPairs.values()].filter(
        (status) => status === 'matched'
      ).length,
      internalTransfersPending: [...transferPairs.values()].filter(
        (status) => status === 'pending_review'
      ).length,
      byReason,
    },
    transactions,
  };
};
