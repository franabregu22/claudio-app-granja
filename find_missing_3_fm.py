#!/usr/bin/env python3
import json
import sys

with open('_preview_batches.json', 'r', encoding='utf-8') as f:
    batches = json.load(f)

lib_batch = batches['liberaciones']
report_batch = batches['report']

# Count descriptions
descriptions = {}
for row in lib_batch:
    desc = row.get('DESCRIPTION', 'MISSING')
    descriptions[desc] = descriptions.get(desc, 0) + 1

print("BATCH COMPOSITION:")
print("=" * 70)
for desc in sorted(descriptions.keys()):
    count = descriptions[desc]
    print("  {}: {} rows".format(desc, count))
print("  TOTAL: {} rows".format(sum(descriptions.values())))

print("\n" + "=" * 70)
print("NEW_FM IDENTIFIED FROM LIBERACIONES BATCH:")
print("=" * 70)
print("  + 16 payouts (all create new FM)")
print("  +  2 payments (no Report match):")
print("      162458726007 = -1,000,000.00")
print("      163606899930 = +1,000,935.55")
print("  +  0 asset_management (no Report match)")
print("  ----------")
print("  = 18 NEW_FM from Liberaciones batch")

print("\n" + "=" * 70)
print("RECONCILIATION:")
print("=" * 70)
print("Preview says: NEW_FM = 21")
print("Accounted:    18")
print("MISSING:      3")

print("\n" + "=" * 70)
print("HYPOTHESIS FOR MISSING 3:")
print("=" * 70)
print("Multi-settlement collapse corrections (existing SR):")
print("  These are EXISTING source_records being 'uncollapsed':")
print("  - SR 3903: +1,629.44 (was collapsed into FM3902, now separate FM/LE)")
print("  - SR 3909: +463.84  (was collapsed into FM3908, now separate FM/LE)")
print("  - Unknown: 1 more existing SR correction")
print("\nThese would appear in v_create_fm_from_sr counter, not in Liberaciones batch")

print("\nTo verify: Need to check Report SR in DB for multi-settlement patterns")
print("Status: CANNOT VERIFY without DB access")
print("Need: Check Supabase for historical SR with collapse patterns")
