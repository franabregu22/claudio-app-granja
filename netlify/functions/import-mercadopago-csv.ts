import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import * as csv from 'csv-parse/sync';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ACCOUNT_ID = 1054315166;

interface CSVRecord {
  SOURCE_ID: string;
  TRANSACTION_DATE: string;
  SETTLEMENT_DATE?: string;
  TRANSACTION_AMOUNT: string;
  SETTLEMENT_NET_AMOUNT: string;
  TAXES_AMOUNT: string;
  TAX_DETAIL?: string;
  PAYMENT_METHOD_TYPE?: string;
  PAYER_NAME?: string;
  PAYER_ID_TYPE?: string;
  PAYER_ID_NUMBER?: string;
  EXTERNAL_REFERENCE?: string;
  [key: string]: any;
}

const handler: Handler = async (event, context) => {
  try {
    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'CSV file required' }),
      };
    }

    // Parse CSV from body
    const csvContent = Buffer.from(event.body, 'base64').toString('utf-8');
    const records: CSVRecord[] = csv.parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    console.log(`📊 Importando ${records.length} registros de CSV`);

    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const record of records) {
      try {
        const sourceId = record.SOURCE_ID?.trim();
        if (!sourceId) {
          skipped++;
          continue;
        }

        const rawData = {
          ...record,
          TRANSACTION_AMOUNT: parseFloat(record.TRANSACTION_AMOUNT || '0'),
          SETTLEMENT_NET_AMOUNT: parseFloat(record.SETTLEMENT_NET_AMOUNT || '0'),
          TAXES_AMOUNT: parseFloat(record.TAXES_AMOUNT || '0'),
        };

        // Insert raw record (deduplicated by source_type + source_external_id)
        const { error: rawError, data: rawData_ } = await supabase
          .from('mp_source_record')
          .insert({
            source_type: 'report',
            source_external_id: sourceId,
            payload_hash: require('crypto')
              .createHash('sha256')
              .update(JSON.stringify(rawData))
              .digest('hex'),
            raw_data: rawData,
            observed_at: new Date(record.TRANSACTION_DATE).toISOString(),
          })
          .select();

        if (rawError) {
          // Might be duplicate, which is OK
          if (rawError.code !== '23505') {
            errors.push(`SOURCE_ID ${sourceId}: ${rawError.message}`);
          }
          skipped++;
          continue;
        }

        inserted++;
      } catch (err) {
        errors.push(`Row error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`✅ Inserted: ${inserted}, Skipped: ${skipped}, Errors: ${errors.length}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        summary: {
          total: records.length,
          inserted,
          skipped,
          errors: errors.slice(0, 10), // Return first 10 errors
        },
        message: `Importación completada: ${inserted} registros nuevos, ${skipped} duplicados o sin datos`,
      }),
    };
  } catch (error) {
    console.error('Import error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Import failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

export { handler };
