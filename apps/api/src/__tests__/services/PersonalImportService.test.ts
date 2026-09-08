import * as XLSX from 'xlsx';
import { buildPersonalImportPreview } from '../../services/personalImport/PersonalImportService';
import type {
  ImportSourceConfig,
  PersonalImportManifest,
} from '../../services/personalImport/types';

const source = (
  sourceId: string,
  accountId: string,
  bank = 'Test Bank'
): ImportSourceConfig => ({
  path: `${sourceId}.xlsx`,
  sourceId,
  bank,
  accountId,
  accountName: accountId,
  defaultCurrency: 'EUR',
});

const workbookBuffer = (rows: unknown[][]): Buffer => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    'Transactions'
  );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
};

const preview = (
  sources: ImportSourceConfig[],
  rowsBySource: unknown[][][]
) => {
  const manifest: PersonalImportManifest = {
    since: '2026-01-01',
    targetDatabase: 'fintrak_personal',
    sources,
  };
  const buffers = new Map(
    sources.map((item, index) => [
      item.sourceId,
      workbookBuffer(rowsBySource[index]),
    ])
  );
  return buildPersonalImportPreview(
    manifest,
    buffers,
    '2026-09-06T12:00:00.000Z'
  );
};

const headers = [
  'Fecha',
  'F.Valor',
  'Concepto',
  'Importe',
  'Divisa',
  'Observaciones',
  'Saldo',
  'Movimiento',
];

describe('PersonalImportService', () => {
  it('deduplicates overlapping statements while retaining provenance', () => {
    const rows = [
      headers,
      ['01/01/2026', '01/01/2026', 'Salary', 100, 'EUR', '', 1100],
      ['02/01/2026', '02/01/2026', 'Groceries', -50, 'EUR', '', 1050],
    ];
    const result = preview(
      [source('export-a', 'checking'), source('export-b', 'checking')],
      [rows, rows]
    );

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].provenance).toHaveLength(2);
    expect(result.accounts[0].currencies[0]).toMatchObject({
      transactionCount: 2,
      debits: -50,
      credits: 100,
      net: 50,
      inferredOpeningBalance: 1000,
      closingBalance: 1050,
      reconciliationDifference: 0,
    });
    expect(result.writePerformed).toBe(false);
    expect(result.readyForLoad).toBe(true);
  });

  it('preserves indistinguishable legitimate rows and flags them for review', () => {
    const result = preview(
      [source('cash', 'checking')],
      [
        [
          headers,
          ['03/01/2026', '', 'ATM withdrawal', -100, 'EUR', '', ''],
          ['03/01/2026', '', 'ATM withdrawal', -100, 'EUR', '', ''],
        ],
      ]
    );

    expect(result.transactions).toHaveLength(2);
    expect(new Set(result.transactions.map((item) => item.importId)).size).toBe(
      2
    );
    for (const transaction of result.transactions) {
      expect(transaction.classification.reviewReasons).toEqual(
        expect.arrayContaining(['ambiguous_duplicate', 'cash_use_unconfirmed'])
      );
    }
  });

  it('applies confirmed rules to concept and observations without overwriting source text', () => {
    const result = preview(
      [source('rules', 'shared')],
      [
        [
          headers,
          [
            '04/01/2026',
            '',
            'Generic direct debit',
            -350,
            'EUR',
            'Navio Alvarez',
            '',
          ],
          ['05/01/2026', '', 'Linea Directa', -150.39, 'EUR', '', ''],
          ['06/01/2026', '', 'Linea Directa', -300, 'EUR', '', ''],
          ['07/01/2026', '', 'HP Instant Ink', -7.99, 'EUR', '', ''],
          ['08/01/2026', '', 'HP Instant Ink', -1.79, 'EUR', '', ''],
          ['09/01/2026', '', 'Nabu Casa', -7.5, 'EUR', '', ''],
          ['10/01/2026', '', 'GitHub', -4, 'EUR', '', ''],
          ['11/01/2026', '', 'SpotifyES', -20.99, 'EUR', '', ''],
        ],
      ]
    );

    const navio = result.transactions.find(
      (item) => item.originalConcept === 'Generic direct debit'
    );
    expect(navio).toMatchObject({
      originalObservations: 'Navio Alvarez',
      classification: { category: 'education' },
    });

    const linea = result.transactions.filter((item) =>
      item.originalConcept.includes('Linea Directa')
    );
    expect(
      linea.find((item) => item.amount === -150.39)?.classification
    ).toMatchObject({ category: 'health' });
    expect(
      linea.find((item) => item.amount === -300)?.classification.reviewReasons
    ).toContain('linea_directa_other_charge');

    expect(
      result.transactions.find((item) => item.amount === -7.99)?.classification
        .note
    ).toContain('preserve');
    expect(
      result.transactions.find((item) => item.amount === -1.79)?.classification
        .reviewReasons
    ).toContain('hp_instant_ink_effective_date_unconfirmed');
    expect(
      result.transactions.find((item) => item.originalConcept === 'Nabu Casa')
        ?.classification.tags
    ).toEqual(expect.arrayContaining(['home-assistant', 'remote-access']));
    expect(
      result.transactions.find((item) => item.originalConcept === 'GitHub')
        ?.classification.reviewReasons
    ).toContain('possible_professional_expense');
    expect(
      result.transactions.find((item) => item.originalConcept === 'SpotifyES')
        ?.classification.category
    ).toBe('subscriptions');
  });

  it('matches unique same-currency transfers and keeps currencies separate', () => {
    const result = preview(
      [
        source('eur-out', 'bbva'),
        source('eur-in', 'revolut-eur'),
        {
          ...source('gbp', 'revolut-gbp', 'Revolut'),
          defaultCurrency: 'GBP',
        },
      ],
      [
        [
          headers,
          ['11/01/2026', '', 'Transfer to Revolut', -200, 'EUR', '', ''],
        ],
        [headers, ['11/01/2026', '', 'Transfer from BBVA', 200, 'EUR', '', '']],
        [headers, ['12/01/2026', '', 'Card payment', -20, 'GBP', '', '']],
      ]
    );

    expect(result.review.internalTransfersMatched).toBe(1);
    expect(result.review.internalTransfersPending).toBe(0);
    expect(
      result.transactions.filter(
        (item) => item.internalTransfer?.status === 'matched'
      )
    ).toHaveLength(2);
    expect(
      result.accounts.flatMap((account) =>
        account.currencies.map((currency) => currency.currency)
      )
    ).toEqual(expect.arrayContaining(['EUR', 'GBP']));
    expect(result.warnings.join(' ')).toContain('No approximate EUR/GBP rate');
  });

  it('keeps cross-currency transfer candidates pending without applying an FX rate', () => {
    const result = preview(
      [
        source('eur', 'bbva'),
        {
          ...source('gbp', 'revolut-gbp', 'Revolut'),
          defaultCurrency: 'GBP',
        },
      ],
      [
        [
          headers,
          ['13/01/2026', '', 'Transfer to Revolut', -117, 'EUR', '', ''],
        ],
        [
          headers,
          [
            '13/01/2026',
            '',
            'Pago de account holder',
            100,
            'GBP',
            '',
            '',
            'Recargas',
          ],
        ],
      ]
    );

    expect(result.review.internalTransfersPending).toBe(1);
    expect(result.transactions[0].internalTransfer?.reason).toContain(
      'no approximate FX rate'
    );
    expect(result.review.byReason.internal_transfer_cross_currency).toBe(2);
  });
});
