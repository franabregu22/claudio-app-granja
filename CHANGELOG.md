# Changelog

All notable changes to Claudio App Granja will be documented in this file.

## [1.0.0] - 2026-08-28

### Added
- **Cash Flow Summary Table** in Caja module showing Apertura → Ingresos → Egresos → Subtotal per payment method (Efectivo, BNA, MercadoPago, Cheque, E-Cheq, Otros)
- **Neto Mensual** row as summary across all payment methods
- **Arqueo de Caja Chica** section (simplified to only cash audit, removed digital account arqueos)
- Integration of arqueo data: opening balance (Saldo Inicial) for Efectivo now pulls from last Caja Chica audit
- **Responsive Caja module** for mobile (compact layout, last month only in table)
- **Responsive Movements table** (mobile: Fecha Op., Nombre, Monto, Checkbox; desktop: all columns)
- **Responsive Production table** (mobile: now shows Cachados and Mortandad; desktop: unchanged)
- **Dual table layouts** using Tailwind responsive utilities (hidden md:block, md:hidden patterns)

### Fixed
- Payment creation error: changed `estado` to `movimiento_estado` column name when auto-creating movements in movimientos_caja
- Payments now correctly register in Caja on creation
- Mobile tables no longer require horizontal scroll
- Resumen Saldos more compact on mobile (no percentages, abbreviated labels)

### Changed
- Moved P&L (devengado basis) to separate Finanzas module
- Caja module now focused on cash flow only (accrual basis for dates, cash basis for payments)
- Production table font sizes responsive (text-xs mobile, text-sm desktop)
- Reduced padding and column widths for mobile compactness

### Architecture
- Added `agregado_a_caja` field to MovimientoCaja type (boolean tracking)
- Added `transferencia` to payment methods (mapped to BNA)
- Flexible table structure: mobile/desktop versions coexist without duplication

## [0.9.9] - 2026-08-27
- Initial dashboard redesign, mobile UX improvements, audit trails
