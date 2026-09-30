import { ACCOUNT_TYPES, type AccountType } from '../../target/masters';
import { MasterEditor } from './MasterEditor';

const LABEL: Record<AccountType, string> = { CASH: 'Efectivo', BANK_ACCOUNT: 'Cuenta bancaria', EXTERNAL_SERVICE: 'Servicio externo (billetera)' };

/**
 * Target `financial_account` (ADMIN master). Balances are not shown here: they come only from
 * `report_balance_period` (F27-D). The account type is set on creation and not edited afterwards.
 */
export function CuentasAdmin() {
  return (
    <MasterEditor
      table="financial_account"
      title="Cuentas"
      fields={[
        { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Nombre de la cuenta' },
        { key: 'account_type', label: 'Tipo', type: 'select', editable: false, options: ACCOUNT_TYPES.map((t) => ({ value: t, label: LABEL[t] })) },
      ]}
    />
  );
}
