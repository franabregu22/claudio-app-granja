import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ACCOUNT_ID = 1054315166;
const CLIENT_ID = process.env.MERCADOPAGO_CLIENT_ID;
const CLIENT_SECRET = process.env.MERCADOPAGO_CLIENT_SECRET;

async function getMercadoPagoToken(): Promise<string> {
  const response = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      grant_type: 'client_credentials',
      scope: 'api',
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Failed to get MP token: ${response.statusText}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function getMercadoPagoMovements(
  token: string,
  startDate: string,
  endDate: string
): Promise<any[]> {
  console.log(`📥 Trayendo movimientos de MP desde ${startDate} hasta ${endDate}`);

  const url = new URL('https://api.mercadopago.com/v1/account/bank_report/list');
  url.searchParams.set('status', 'settled');
  url.searchParams.set('begin_date', startDate);
  url.searchParams.set('end_date', endDate);
  url.searchParams.set('limit', '1000');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`MP API error: ${response.statusText}`);
  }

  const data = (await response.json()) as { results: any[] };
  return data.results || [];
}

const handler: Handler = async (event) => {
  try {
    // Parse query params
    const params = new URLSearchParams(event.queryStringParameters || {});
    const startDate = params.get('start') || '2026-09-11'; // Default: 11 sept
    const endDate = params.get('end') || new Date().toISOString().split('T')[0]; // Default: today

    console.log(`🔄 Sincronizando MercadoPago: ${startDate} a ${endDate}`);

    // Get token
    const token = await getMercadoPagoToken();

    // Fetch movements
    const movements = await getMercadoPagoMovements(token, startDate, endDate);
    console.log(`✅ Traídos ${movements.length} movimientos de MP`);

    if (movements.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'No hay movimientos en el período',
          inserted: 0,
        }),
      };
    }

    // Process each movement
    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const mov of movements) {
      try {
        const sourceId = mov.source_id || `mp_${mov.id}`;

        const rawData = {
          SOURCE_ID: sourceId,
          TRANSACTION_DATE: mov.transaction_date || mov.date_created,
          SETTLEMENT_NET_AMOUNT: mov.net_credit_amount || mov.net_debit_amount || 0,
          TRANSACTION_AMOUNT: mov.gross_amount || 0,
          TAXES_AMOUNT: mov.mp_fee_amount || 0,
          PAYMENT_METHOD_TYPE: mov.payment_method || null,
          PAYER_NAME: mov.payer_name || null,
          ...mov, // Include all original fields
        };

        const payloadHash = crypto
          .createHash('sha256')
          .update(JSON.stringify(rawData))
          .digest('hex');

        // Insert raw record
        const { error: rawError } = await supabase.from('mp_source_record').insert({
          source_type: 'api',
          source_external_id: sourceId,
          payload_hash: payloadHash,
          raw_data: rawData,
          observed_at: new Date(mov.transaction_date || mov.date_created).toISOString(),
        });

        if (rawError) {
          if (rawError.code !== '23505') {
            // Not a unique constraint violation
            errors.push(`${sourceId}: ${rawError.message}`);
          }
          skipped++;
          continue;
        }

        inserted++;
      } catch (err) {
        errors.push(`Movement error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`📊 Resultado: ${inserted} nuevos, ${skipped} duplicados, ${errors.length} errores`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        summary: {
          total: movements.length,
          inserted,
          skipped,
          errors: errors.slice(0, 5),
        },
        message: `Sincronización completada: ${inserted} registros nuevos, ${skipped} duplicados`,
      }),
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};

export { handler };
