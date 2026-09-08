export type SupportedCurrency = 'EUR' | 'GBP' | 'USD';

export interface ImportSourceConfig {
  path: string;
  sourceId: string;
  bank: string;
  accountId: string;
  accountName: string;
  defaultCurrency?: SupportedCurrency;
}

export interface PersonalImportManifest {
  since: string;
  targetDatabase: 'fintrak_personal';
  sources: ImportSourceConfig[];
}

export interface SourceLocation {
  sourceId: string;
  fileName: string;
  sheetName: string;
  rowNumber: number;
}

export type ReviewReason =
  | 'ambiguous_duplicate'
  | 'cash_use_unconfirmed'
  | 'hp_instant_ink_effective_date_unconfirmed'
  | 'internal_transfer_ambiguous'
  | 'internal_transfer_cross_currency'
  | 'linea_directa_other_charge'
  | 'possible_professional_expense';

export interface ClassificationSuggestion {
  category?: string;
  tags: string[];
  reviewReasons: ReviewReason[];
  note?: string;
}

export interface NormalizedBankTransaction {
  importId: string;
  fingerprint: string;
  occurrence: number;
  bankReference?: string;
  bank: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  valueDate?: string;
  amount: number;
  fee?: number;
  currency: SupportedCurrency;
  originalConcept: string;
  originalObservations?: string;
  movementType?: string;
  balanceAfter?: number;
  provenance: SourceLocation[];
  classification: ClassificationSuggestion;
  internalTransfer?: {
    matchId: string;
    counterpartImportId: string;
    status: 'matched' | 'pending_review';
    reason: string;
  };
}

export interface SourcePreview {
  sourceId: string;
  fileName: string;
  bank: string;
  accountId: string;
  accountName: string;
  rowsRead: number;
  rowsAccepted: number;
  rowsBeforeCutoff: number;
  rowsExcluded: number;
  excludedByStatus: Record<string, number>;
  errors: string[];
}

export interface CurrencyReconciliation {
  currency: SupportedCurrency;
  transactionCount: number;
  debitCount: number;
  creditCount: number;
  debits: number;
  credits: number;
  fees: number;
  net: number;
  netAfterFees: number;
  inferredOpeningBalance: number | null;
  closingBalance: number | null;
  reconciliationDifference: number | null;
}

export interface AccountPreview {
  accountId: string;
  accountName: string;
  bank: string;
  currencies: CurrencyReconciliation[];
}

export interface PersonalImportPreview {
  generatedAt: string;
  since: string;
  targetDatabase: 'fintrak_personal';
  writePerformed: false;
  readyForLoad: boolean;
  blockers: string[];
  warnings: string[];
  sources: SourcePreview[];
  accounts: AccountPreview[];
  review: {
    transactionCount: number;
    internalTransfersMatched: number;
    internalTransfersPending: number;
    byReason: Partial<Record<ReviewReason, number>>;
  };
  transactions: NormalizedBankTransaction[];
}
