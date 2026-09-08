import mongoose, { type Connection, type mongo } from 'mongoose';
import type {
  NormalizedBankTransaction,
  PersonalImportPreview,
  SourceLocation,
} from './types';

export const PERSONAL_IMPORT_DATABASE = 'fintrak_personal';
export const PERSONAL_IMPORT_COLLECTION = 'personal_bank_transactions';

interface StoredPersonalBankTransaction {
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
  currency: string;
  originalConcept: string;
  originalObservations?: string;
  movementType?: string;
  balanceAfter?: number;
  provenance: SourceLocation[];
  classificationSuggestion: NormalizedBankTransaction['classification'];
  internalTransfer?: NormalizedBankTransaction['internalTransfer'];
  sourceSchemaVersion: 1;
  createdAt: Date;
}

export interface PersonalImportLoadResult {
  targetDatabase: typeof PERSONAL_IMPORT_DATABASE;
  collection: typeof PERSONAL_IMPORT_COLLECTION;
  sourceTransactionCount: number;
  insertedCount: number;
  existingCount: number;
  provenanceUpdatedCount: number;
  verifiedCount: number;
}

interface PersistedReconciliation {
  _id: { accountId: string; currency: string };
  transactionCount: number;
  net: number;
  fees: number;
}

const ensureSafeTarget = (preview: PersonalImportPreview): void => {
  if (preview.targetDatabase !== PERSONAL_IMPORT_DATABASE) {
    throw new Error(
      `Personal imports may only target ${PERSONAL_IMPORT_DATABASE}`
    );
  }
  if (!preview.readyForLoad || preview.blockers.length > 0) {
    throw new Error(
      `Preview has load blockers: ${preview.blockers.join(', ') || 'unknown blocker'}`
    );
  }
};

export const validatePersonalMongoUri = (uri: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('PERSONAL_MONGODB_URI is not a valid MongoDB URI');
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('PERSONAL_MONGODB_URI must use mongodb or mongodb+srv');
  }

  const configuredDatabase = parsed.pathname.replace(/^\//, '');
  if (configuredDatabase && configuredDatabase !== PERSONAL_IMPORT_DATABASE) {
    throw new Error(
      `PERSONAL_MONGODB_URI must not select ${configuredDatabase}; the loader only permits ${PERSONAL_IMPORT_DATABASE}`
    );
  }
};

const insertDocument = (
  transaction: NormalizedBankTransaction
): Omit<StoredPersonalBankTransaction, 'provenance'> => ({
  importId: transaction.importId,
  fingerprint: transaction.fingerprint,
  occurrence: transaction.occurrence,
  ...(transaction.bankReference && {
    bankReference: transaction.bankReference,
  }),
  bank: transaction.bank,
  accountId: transaction.accountId,
  accountName: transaction.accountName,
  bookingDate: transaction.bookingDate,
  ...(transaction.valueDate && { valueDate: transaction.valueDate }),
  amount: transaction.amount,
  ...(transaction.fee !== undefined && { fee: transaction.fee }),
  currency: transaction.currency,
  originalConcept: transaction.originalConcept,
  ...(transaction.originalObservations && {
    originalObservations: transaction.originalObservations,
  }),
  ...(transaction.movementType && { movementType: transaction.movementType }),
  ...(transaction.balanceAfter !== undefined && {
    balanceAfter: transaction.balanceAfter,
  }),
  classificationSuggestion: transaction.classification,
  ...(transaction.internalTransfer && {
    internalTransfer: transaction.internalTransfer,
  }),
  sourceSchemaVersion: 1,
  createdAt: new Date(),
});

const openPersonalImportConnection = async (
  uri: string
): Promise<Connection> => {
  validatePersonalMongoUri(uri);
  const connection = mongoose.createConnection(uri, {
    dbName: PERSONAL_IMPORT_DATABASE,
    serverSelectionTimeoutMS: 15_000,
  });
  await connection.asPromise();
  if (connection.name !== PERSONAL_IMPORT_DATABASE) {
    await connection.close();
    throw new Error(
      `Connected database ${connection.name} is not ${PERSONAL_IMPORT_DATABASE}`
    );
  }
  return connection;
};

const verifyPersistedReconciliation = async (
  collection: mongo.Collection<StoredPersonalBankTransaction>,
  preview: PersonalImportPreview,
  importIds: string[]
): Promise<void> => {
  const persisted = await collection
    .aggregate<PersistedReconciliation>([
      { $match: { importId: { $in: importIds } } },
      {
        $group: {
          _id: { accountId: '$accountId', currency: '$currency' },
          transactionCount: { $sum: 1 },
          net: { $sum: '$amount' },
          fees: { $sum: { $ifNull: ['$fee', 0] } },
        },
      },
    ])
    .toArray();
  const expected = preview.accounts.flatMap((account) =>
    account.currencies.map((currency) => ({
      accountId: account.accountId,
      currency: currency.currency,
      transactionCount: currency.transactionCount,
      net: currency.net,
      fees: currency.fees,
    }))
  );

  const persistedByAccount = new Map(
    persisted.map((item) => [
      `${item._id.accountId}:${item._id.currency}`,
      item,
    ])
  );
  for (const item of expected) {
    const key = `${item.accountId}:${item.currency}`;
    const actual = persistedByAccount.get(key);
    if (
      !actual ||
      actual.transactionCount !== item.transactionCount ||
      Math.abs(actual.net - item.net) > 0.005 ||
      Math.abs(actual.fees - item.fees) > 0.005
    ) {
      throw new Error(`Persisted reconciliation failed for ${key}`);
    }
  }
  if (persisted.length !== expected.length) {
    throw new Error('Persisted reconciliation returned unexpected accounts');
  }
};

/**
 * Inserts only source fields for records that do not already exist. Reimports
 * only add previously unseen provenance entries, leaving all manual fields and
 * prior user decisions unchanged.
 */
export const loadPersonalImport = async (
  preview: PersonalImportPreview,
  uri: string
): Promise<PersonalImportLoadResult> => {
  ensureSafeTarget(preview);
  const connection = await openPersonalImportConnection(uri);

  try {
    const database = connection.db;
    if (!database) {
      throw new Error('MongoDB connection did not expose a database handle');
    }
    const collection = database.collection<StoredPersonalBankTransaction>(
      PERSONAL_IMPORT_COLLECTION
    );
    await collection.createIndex({ importId: 1 }, { unique: true });
    await collection.createIndex({
      accountId: 1,
      bookingDate: -1,
      currency: 1,
    });

    const result = await collection.bulkWrite(
      preview.transactions.map((transaction) => ({
        updateOne: {
          filter: { importId: transaction.importId },
          update: {
            $setOnInsert: insertDocument(transaction),
            $addToSet: { provenance: { $each: transaction.provenance } },
          },
          upsert: true,
        },
      })),
      { ordered: true }
    );

    const importIds = preview.transactions.map(
      (transaction) => transaction.importId
    );
    const verifiedCount = await collection.countDocuments({
      importId: { $in: importIds },
    });
    if (verifiedCount !== preview.transactions.length) {
      throw new Error(
        `Post-load verification failed: expected ${preview.transactions.length} records, found ${verifiedCount}`
      );
    }
    await verifyPersistedReconciliation(collection, preview, importIds);

    return {
      targetDatabase: PERSONAL_IMPORT_DATABASE,
      collection: PERSONAL_IMPORT_COLLECTION,
      sourceTransactionCount: preview.transactions.length,
      insertedCount: result.upsertedCount,
      existingCount: result.matchedCount,
      provenanceUpdatedCount: result.modifiedCount,
      verifiedCount,
    };
  } finally {
    await connection.close();
  }
};
