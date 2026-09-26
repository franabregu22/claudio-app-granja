-- ============================================================================
-- TARGET V1 — 0002 ENUM TYPES (28)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md "ENUM TYPES"
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md, Phase 1
--
-- All 28 are created in Foundations because every later table depends on them.
-- Values are copied verbatim from the frozen spec. None were invented.
-- ============================================================================

CREATE TYPE rol_type                    AS ENUM ('ADMIN','OPERATOR');
CREATE TYPE order_estado                AS ENUM ('PENDING','DELIVERED','CANCELLED');
CREATE TYPE product_type                AS ENUM ('VENDIBLE','INPUT','BOTH');
CREATE TYPE price_list_type             AS ENUM ('MAYORISTA','MINORISTA');
CREATE TYPE account_type                AS ENUM ('CASH','BANK_ACCOUNT','EXTERNAL_SERVICE');

CREATE TYPE financial_operation_type    AS ENUM (
  'TRANSFER','FEE','COLLECTION','CHEQUE_CLEAR','CHEQUE_REJECTION',
  'SUPPLIER_PAYMENT','INSTRUMENT_DEBIT','INSTRUMENT_DEBIT_REVERSAL',
  'FREIGHT_PAYMENT','FISCAL_PAYMENT','SESSION_CASH','MP_SETTLEMENT','ADJUSTMENT');

CREATE TYPE financial_instrument_type   AS ENUM ('CHEQUE','ECHEQ');
CREATE TYPE instrument_direction        AS ENUM ('RECEIVED','ISSUED');
CREATE TYPE instrument_estado           AS ENUM (
  'RECEIVED','DEPOSITED','CLEARED','ENDORSED',
  'ISSUED','DEBITED',
  'REJECTED','CANCELLED');

CREATE TYPE client_ledger_movement_type AS ENUM (
  'SALE_DELIVERY','COLLECTION','CHEQUE_RECEIVED','CHEQUE_REJECTED',
  'ADJUSTMENT','REVERSAL','OPENING_BALANCE');

CREATE TYPE supplier_ledger_movement_type AS ENUM (
  'PURCHASE','PAYMENT','CHEQUE_ENDORSED','INSTRUMENT_ISSUED','INSTRUMENT_REJECTED',
  'FREIGHT','ADJUSTMENT','REVERSAL','OPENING_BALANCE');

CREATE TYPE payment_method              AS ENUM ('CASH','CHEQUE','TRANSFER','MERCADOPAGO');
CREATE TYPE purchase_nature             AS ENUM ('OPERATING','REINVESTMENT','INVESTMENT');

CREATE TYPE population_event_type       AS ENUM ('MORTALITY','COUNT_ADJUSTMENT');
CREATE TYPE flock_estado                AS ENUM ('ACTIVE','RETIRED','ARCHIVED');

CREATE TYPE feed_category               AS ENUM ('LAYER','BROILER','PULLET','INPUT');
CREATE TYPE unit_type                   AS ENUM ('KG','TON','LITER','UNIT','CARTON');
CREATE TYPE feed_movement_type          AS ENUM (
  'EXTERNAL_SALE','ADJUSTMENT_POSITIVE','ADJUSTMENT_NEGATIVE','LOSS');

CREATE TYPE session_estado              AS ENUM ('OPEN','CLOSED');
CREATE TYPE session_movement_type       AS ENUM ('DISPATCH','RETURN','LOSS','ADJUSTMENT');
CREATE TYPE session_cash_event_type     AS ENUM (
  'OPENING_FUND','EXPENSE','WITHDRAWAL','TRANSFER_OUT','COUNT');

CREATE TYPE fiscal_document_type        AS ENUM (
  'INVOICE_A','INVOICE_B','INVOICE_C','CREDIT_NOTE','DEBIT_NOTE','RECEIPT','OTHER');
CREATE TYPE fiscal_direction            AS ENUM ('DEBITO','CREDITO');
CREATE TYPE tax_kind                    AS ENUM (
  'IVA','IIBB','GANANCIAS','RETENTION','PERCEPTION','OTHER');
CREATE TYPE fiscal_obligation_status    AS ENUM ('PENDING','PARTIALLY_PAID','PAID','CANCELLED');

CREATE TYPE management_period_status    AS ENUM ('OPEN','CLOSED');
CREATE TYPE project_status              AS ENUM ('ACTIVE','PAUSED','CLOSED');
CREATE TYPE mp_processing_status        AS ENUM (
  'PENDING','NORMALIZED','RECONCILED','IGNORED','ERROR');
