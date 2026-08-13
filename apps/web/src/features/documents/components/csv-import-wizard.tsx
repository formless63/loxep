import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { checkCommittedFingerprints, stageCsvImport } from '@/server/documents-functions';
import {
  CSV_FIELDS,
  guessColumnMapping,
  mapCsvRows,
  parseCsvText,
  type CsvCandidateInput,
  type CsvColumnMapping,
  type CsvField,
  type CsvParseResult
} from '@/features/documents/lib/csv';

const FIELD_LABELS: Record<CsvField, string> = {
  date: 'Date',
  description: 'Description',
  amount: 'Amount',
  payee: 'Payee',
  currency: 'Currency'
};

const NO_COLUMN_VALUE = '__none__';

/**
 * CSV expense import — upload, operator-guided column mapping (best guess
 * from header names), a dry-run preview with per-row warnings and a
 * duplicate-fingerprint WARNING (never a block — detect, don't constrain),
 * then stage into a `documents`/`document_line_candidates` review batch.
 * Confirming staged rows into `expenses` happens on the review panel this
 * component hands off to via `onStaged`.
 *
 * The dry-run preview below is a bare `<Table>`, deliberately NOT the
 * sanctioned `DataTable`/`useDataTable` — the two reasons together, not
 * either alone: (1) `useDataTable` keys pagination/sorting into the ROUTE's
 * own `page`/`perPage`/`sort` search params, and `CandidatesTable`
 * (rendered on this SAME route once a document is staged) already owns
 * those keys — two `useDataTable` instances on one route collide on that
 * shared URL state; (2) this preview has no persisted identity of its own —
 * it exists for one dry run and is discarded the moment "Stage" succeeds
 * (`onStaged` swaps the view to the real, persisted, DataTable-backed
 * review), so there is nothing here a shareable/bookmarkable sort or page
 * would ever apply to. `CandidatesTable` is the list this milestone's data
 * actually lives in, and it uses `DataTable` properly.
 */
export default function CsvImportWizard({ onStaged }: { onStaged: (documentId: string) => void }) {
  const queryClient = useQueryClient();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [parsed, setParsed] = React.useState<CsvParseResult | null>(null);
  const [mapping, setMapping] = React.useState<CsvColumnMapping>({});
  const [defaultCurrency, setDefaultCurrency] = React.useState('USD');
  const [mappedRows, setMappedRows] = React.useState<CsvCandidateInput[] | null>(null);
  const [duplicateFingerprints, setDuplicateFingerprints] = React.useState<Set<string>>(new Set());

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!parsed) throw new Error('no file parsed yet');
      const rows = await mapCsvRows(parsed, mapping, { defaultCurrency });
      const { committed } = await checkCommittedFingerprints({
        data: { fingerprints: rows.map((r) => r.rowFingerprint) }
      });
      return { rows, committed: new Set(committed) };
    },
    onSuccess: ({ rows, committed }) => {
      setMappedRows(rows);
      setDuplicateFingerprints(committed);
    },
    onError: (error) => toastError(error, 'Could not build the preview')
  });

  const importMutation = useMutation({
    mutationFn: () =>
      stageCsvImport({
        data: {
          originalFilename: fileName,
          rows: (mappedRows ?? []).map((row) => ({
            lineNumber: row.lineNumber,
            // `document_line_candidates` has no `payee` column (the
            // design's own DDL) — fold it into `description` rather than
            // drop it, "Payee — description" when both are present, mirrors
            // `@loxep/documents/documents.ts`'s `stageCsvRows`.
            description:
              row.payeeName && row.description
                ? `${row.payeeName} — ${row.description}`
                : (row.description ?? row.payeeName),
            lineAmount: row.lineAmount,
            lineDate: row.lineDate,
            currency: row.currency,
            rowFingerprint: row.rowFingerprint,
            rowWarnings: row.rowWarnings
          }))
        }
      }),
    onSuccess: (result) => {
      toast.success(`Staged ${result.candidates.length} row(s) for review`);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      onStaged(result.documentId);
      setFileName(null);
      setParsed(null);
      setMapping({});
      setMappedRows(null);
      setDuplicateFingerprints(new Set());
    },
    onError: (error) => toastError(error, 'Failed to import the CSV')
  });

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    const result = parseCsvText(text);
    if (result.headers.length === 0) {
      toast.error('That file has no header row Loxep could read');
      return;
    }
    setFileName(file.name);
    setParsed(result);
    setMapping(guessColumnMapping(result.headers));
    setMappedRows(null);
  }

  const readyToStage = mappedRows !== null && mappedRows.some((row) => row.lineAmount !== null);
  const validRowCount = mappedRows?.filter((row) => row.lineAmount !== null).length ?? 0;
  const warnedRowCount = mappedRows?.filter((row) => row.rowWarnings.length > 0).length ?? 0;

  return (
    <div className='space-y-6'>
      <div>
        <input
          ref={fileInputRef}
          type='file'
          accept='.csv,text/csv'
          className='hidden'
          onChange={handleFileChange}
        />
        <Button type='button' variant='outline' onClick={() => fileInputRef.current?.click()}>
          <Icons.upload />
          {fileName ? 'Choose a different CSV' : 'Choose a CSV file'}
        </Button>
        {fileName && (
          <Badge variant='secondary' className='ml-2'>
            {fileName}
          </Badge>
        )}
      </div>

      {parsed && (
        <FieldGroup>
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
            {CSV_FIELDS.map((field) => (
              <Field key={field}>
                <FieldLabel>
                  {FIELD_LABELS[field]}
                  {field === 'amount' && ' *'}
                </FieldLabel>
                <Select
                  value={mapping[field] ?? NO_COLUMN_VALUE}
                  onValueChange={(value) =>
                    setMapping((prev) => ({
                      ...prev,
                      [field]: value === NO_COLUMN_VALUE ? undefined : value
                    }))
                  }
                >
                  <SelectTrigger className='w-full'>
                    <SelectValue placeholder='Not mapped' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_COLUMN_VALUE}>Not mapped</SelectItem>
                    {parsed.headers.map((header) => (
                      <SelectItem key={header} value={header}>
                        {header}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ))}
          </div>
          <Field className='max-w-xs'>
            <FieldLabel>Default currency</FieldLabel>
            <Input
              value={defaultCurrency}
              maxLength={3}
              onChange={(event) => setDefaultCurrency(event.target.value.toUpperCase())}
              placeholder='USD'
            />
          </Field>
          <div>
            <Button
              type='button'
              onClick={() => previewMutation.mutate()}
              disabled={mapping.amount === undefined || previewMutation.isPending}
            >
              Preview
            </Button>
          </div>
        </FieldGroup>
      )}

      {mappedRows && (
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <Badge variant='outline'>{mappedRows.length} row(s) read</Badge>
            <Badge variant={validRowCount > 0 ? 'success' : 'destructive'}>
              {validRowCount} ready to stage
            </Badge>
            {warnedRowCount > 0 && (
              <Badge variant='secondary'>{warnedRowCount} need attention</Badge>
            )}
            {duplicateFingerprints.size > 0 && (
              <Badge variant='secondary'>
                {duplicateFingerprints.size} possible duplicate(s) of already-confirmed rows
              </Badge>
            )}
          </div>

          {duplicateFingerprints.size > 0 && (
            <Alert>
              <Icons.warning />
              <AlertTitle>Possible duplicates</AlertTitle>
              <AlertDescription>
                Some rows match a previously CONFIRMED expense on date, amount, and description.
                This is a warning, not a block — re-importing the same file, or two identical
                purchases on the same day, both look like this. Review before confirming.
              </AlertDescription>
            </Alert>
          )}

          <div className='overflow-x-auto rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className='text-right'>Amount</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappedRows.map((row) => (
                  <TableRow key={row.lineNumber}>
                    <TableCell className='text-muted-foreground tabular-nums'>
                      {row.lineNumber}
                    </TableCell>
                    <TableCell className='tabular-nums'>{row.lineDate ?? '—'}</TableCell>
                    <TableCell>{row.description ?? '—'}</TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {row.lineAmount ? formatMoney(row.lineAmount, row.currency ?? 'USD') : '—'}
                    </TableCell>
                    <TableCell className='space-x-1'>
                      {row.rowWarnings.map((warning) => (
                        <Badge key={warning} variant='destructive'>
                          {warning}
                        </Badge>
                      ))}
                      {duplicateFingerprints.has(row.rowFingerprint) && (
                        <Badge variant='secondary'>possible duplicate</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Button
            type='button'
            onClick={() => importMutation.mutate()}
            disabled={!readyToStage || importMutation.isPending}
          >
            <Icons.add />
            Stage {validRowCount} row(s) for review
          </Button>
        </div>
      )}
    </div>
  );
}
