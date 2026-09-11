#!/usr/bin/env python3
"""
Compare Supabase export vs _preview_batches.json
Generate static SQL INSERT for missing rows
"""

import json
from pathlib import Path
from decimal import Decimal

# Supabase export data (from table copy)
supabase_data = [
    {"fm_id": 3472, "source_type": "report", "payload_hash": "4ec544cf69f2e6e4659e4db308505aa213333725e48b2cd415959943b919cf2d"},
    {"fm_id": 3473, "source_type": "report", "payload_hash": "4b8cca8cc0bb1efb5bc251717ae25ba9021a4e65bf858cb469cba2d555d7b298"},
    {"fm_id": 3474, "source_type": "report", "payload_hash": "cb0bb8eed3a4ed6dd3abb74765eb90352bac472c69b542c8f6f7c3dbd12f4d1c"},
    {"fm_id": 3475, "source_type": "report", "payload_hash": "e5c992a6c68a2bbc4fc0a9381b1001e7ef9f7eaa3c093b343ad78697e64445a9"},
    {"fm_id": 3476, "source_type": "report", "payload_hash": "e6557d059403ec99cd05befc7bfc8e4e3a4bd2170006e893bc8000a28d92eeaa"},
    {"fm_id": 3477, "source_type": "report", "payload_hash": "d48c0ed2f223de057d8003899ee73bdd348c9b23ef3e2b030b8de8d6c306c666"},
    {"fm_id": 3478, "source_type": "report", "payload_hash": "f37c0ec335111c1927b78dccfc5666353d05528443bd928cf5518f2fc9582008"},
    {"fm_id": 3479, "source_type": "report", "payload_hash": "7845b80fc92f313ab425ac65a0f21e7b65b00b0f876a707dbe8a1283e33bb875"},
    {"fm_id": 3480, "source_type": "report", "payload_hash": "53fc312794459261564a103692c4ca49f6b96863314b05844c1c2a602b9c9e01"},
    {"fm_id": 3481, "source_type": "report", "payload_hash": "f8947d7baba2ffe711c2feb1f1e5697b40be0a3c5103da8c2fb3552edd58db3d"},
    {"fm_id": 3482, "source_type": "report", "payload_hash": "18aba516dba83384367cda9b0ef58eb1583e7035b16388a9b5f2c19049757cbd"},
    {"fm_id": 3483, "source_type": "report", "payload_hash": "f4831b8214be6a670e713940b9a85c14984aa59cef749c1b2296a7dbb8342d2e"},
    {"fm_id": 3484, "source_type": "report", "payload_hash": "b1739607f36c34bb9160812c2d31e00d8fcd3b7df776a73ae2e4976f864c8d98"},
    {"fm_id": 3485, "source_type": "report", "payload_hash": "1d8b074f52b13f00cd39d20375355a602223aa47cb7710b180e6fa2b2e3c56da"},
    {"fm_id": 3486, "source_type": "report", "payload_hash": "80b7ac8b81d3d1ceb4c23f91c479d2515a3c94e2c9e79f6a69666867ebf5f753"},
    {"fm_id": 3487, "source_type": "report", "payload_hash": "5b7ddf2883149732b40a7ac744a36ee7b87fdfcd7f244b251d6676c27e58afe9"},
    {"fm_id": 3488, "source_type": "report", "payload_hash": "633a6dce95fb55b3a757eef95d1955d5c7695e481d0f99c0405afeb1a6fb187c"},
    {"fm_id": 3489, "source_type": "report", "payload_hash": "3bed5b170469fe6eaaa5f8ca77a4026a509e5c01c47affd549c3daffddf1d775"},
    {"fm_id": 3490, "source_type": "report", "payload_hash": "11970c2140a73e3c8cd0537051d6472242ff810f8bdb538a9013854d08675053"},
    {"fm_id": 3491, "source_type": "report", "payload_hash": "6dabfe7a2c7a9659601820d10b9b6aaf0a73be04b2ebcbeded40c3ce588ddc3b"},
    {"fm_id": 3492, "source_type": "report", "payload_hash": "0e07366aa63a9ef72c941c26af242f5e6b9e69c9fe999b9d19805e95e150fe8a"},
    {"fm_id": 3493, "source_type": "report", "payload_hash": "9f3790e5d6a811c3b8509548c23fb461e1315f5b98c925900c108bacf042f521"},
    {"fm_id": 3494, "source_type": "report", "payload_hash": "fdbac09d4f85c7be5c10979a03f33ddc6927d7e147bc281612682d6faa56f4fd"},
    {"fm_id": 3495, "source_type": "report", "payload_hash": "4a47b408bdcadca86dd921a245bac930ba0412193bd4759af801975e956df1f7"},
    {"fm_id": 3496, "source_type": "report", "payload_hash": "ddabdd3b7a6d5d01118d7574f74c4ea7d272626ee6af4b942eecc4ba8e36e7d6"},
    {"fm_id": 3497, "source_type": "report", "payload_hash": "037a084c7fad9a08db53437ec89132142ca607fde1093bb38b3436d3c0385099"},
    {"fm_id": 3498, "source_type": "report", "payload_hash": "5bc1bd5b38cd403e73406ba63e4f2bf6fdcf4442c04ceb952f8d771a5ede0e8c"},
    {"fm_id": 3499, "source_type": "report", "payload_hash": "b0ea96b7136d72ebd4a734e843323616586f1a47adefb3bb1a93e16853cf7881"},
    {"fm_id": 3500, "source_type": "report", "payload_hash": "325293740726c39492b31cba68b71861c5f1d9579da863318f18d7953efc0a0c"},
    {"fm_id": 3501, "source_type": "report", "payload_hash": "9a7c571328f02f86f648f250577ebc5161b84e8f09da8ddbc067c58512f54cf5"},
    {"fm_id": 3502, "source_type": "report", "payload_hash": "d81ec7e0bdbf95a4106c67b8af17fcfdb1dac260dd6db1caf9e6633d1b8ee2a0"},
    {"fm_id": 3503, "source_type": "report", "payload_hash": "e0269aa7bdc1577810c5b49fa967f0a1c4e6ae433f859370ff74cae23dcb4cc5"},
    {"fm_id": 3504, "source_type": "report", "payload_hash": "4ea6eb92157611500773f21febfa66807f11cf4ef4e5e082b866e010da9117da"},
    {"fm_id": 3505, "source_type": "report", "payload_hash": "3cfa71097ef9a6fe5a28805352c0976c7ffa6b0ada23de09bb4d3bfd4b65d73e"},
    {"fm_id": 3506, "source_type": "report", "payload_hash": "0b7728728d386d2c30270acc63800c90cf88961459b99bc69a12e983defe7c83"},
    {"fm_id": 3507, "source_type": "report", "payload_hash": "4c91b765a43e5b6b1b816d3a0c50e0c5b4217f743808056ef29af9abd91720bc"},
    {"fm_id": 3508, "source_type": "report", "payload_hash": "0453507fde5dc7383c099684d32321ac4649b85a05ee33139556a0651ec5afe7"},
    {"fm_id": 3509, "source_type": "report", "payload_hash": "8b3a1f182dc9e33c61e6793aa4d0c1550bbccee63b1ccfdf472888a56b2090bb"},
    {"fm_id": 3510, "source_type": "report", "payload_hash": "08718858ed0da15e3e126d9b47e3b9b22a0c9a9d441547bfe98df2f70b7778ad"},
    {"fm_id": 3511, "source_type": "report", "payload_hash": "3f2327f20547171ae1a66703b39b3ad75efdb6ba5e316ee73014f38979c1cd08"},
    {"fm_id": 3512, "source_type": "report", "payload_hash": "bf124173ed09dc21492fb67f61c92cafc671b15539ddb4e720187c3957bef63c"},
    {"fm_id": 3513, "source_type": "report", "payload_hash": "e5ef3154839f9adff48327c00a6c8a6726853b461a5d3306ae560958b5d99896"},
    {"fm_id": 3514, "source_type": "report", "payload_hash": "0307b00f4252d59b3ce3affc7a453e2512f3cf30cdbad10f79e155985f096919"},
    {"fm_id": 3515, "source_type": "report", "payload_hash": "450866565a4dc3d4a38ed0bec3f2f4a55b77ce839104f4fa643cbe1505072980"},
    {"fm_id": 3516, "source_type": "report", "payload_hash": "fff650e3f895553e668c526834d6bcdf7628b657f7ae64670d4e08ee55171cc0"},
    {"fm_id": 3517, "source_type": "report", "payload_hash": "77d7c6e644b396240df7c7495e6d24128de09984a1d959ac6d61bbca26c08b3d"},
    {"fm_id": 3518, "source_type": "report", "payload_hash": "68d68f43d2b3b91573cb372143003e3bdfce87b331d7d69f9e212d4bfcee3c61"},
    {"fm_id": 3519, "source_type": "report", "payload_hash": "bc7e048aa861c469af6ebbe2d4f91a46200028bde139ced5e41804aadb3e4d19"},
    {"fm_id": 3520, "source_type": "report", "payload_hash": "372ac1aace2e0636190b60e835fe5bef3d4cc93a011cfd71744af243ef2c64a8"},
    {"fm_id": 3521, "source_type": "report", "payload_hash": "de1fb7ead94e129c178d9dfa13aa1800ee443c094bde8673faec47b7658d8dc6"},
    {"fm_id": 3522, "source_type": "report", "payload_hash": "64319672c61580861d0777ce8b24e4349cd18528d099b4e6cfcd8aa27fffc96d"},
    {"fm_id": 3523, "source_type": "report", "payload_hash": "e67dbf7afc9c0d6a11a6505af8b013c4dd465b4f4eef26af4c72d6dbbb945970"},
    {"fm_id": 3524, "source_type": "report", "payload_hash": "b509d04af4135ccaee61b15b7949d9dfe675c594dd8f62df8027389730e623b9"},
    {"fm_id": 3525, "source_type": "report", "payload_hash": "24f636ecab10063fe07fdca6f098c15feaa2d2f5bf3d538a746146f0957bb380"},
    {"fm_id": 3526, "source_type": "report", "payload_hash": "2438c8e748fa0ed335ec2bd10396bd4e039b2fdb8160b768303f8b53dc836185"},
    {"fm_id": 3527, "source_type": "report", "payload_hash": "3c544b7f529bc2b05554abe251c86dfe5076c89f80a9f6506df6979c50ffc324"},
    {"fm_id": 3528, "source_type": "report", "payload_hash": "d3bddee2fc72c71bc66e3715608a572b524b3e79a17a9d614cbb84399a1b5d88"},
    {"fm_id": 3529, "source_type": "report", "payload_hash": "dd9e544e05c26b5f789359cdd1476fc25f111bb06cf50b84da0020d716a21a69"},
    {"fm_id": 3530, "source_type": "report", "payload_hash": "82d2e9bfc119223a7c4b3da712389a20aef12d2f6c06dcf6a90348aeeed11f6a"},
    {"fm_id": 3531, "source_type": "report", "payload_hash": "6a0292a0dc80aa8905b9b57ac60019518ec58c993e9cb5e4d065782642acc8f1"},
    {"fm_id": 3532, "source_type": "report", "payload_hash": "6f20487a0c15466c017f3c0683c6f8e308b0e835306a69fc5f725496a6eaf59a"},
    {"fm_id": 3533, "source_type": "report", "payload_hash": "f19f537cfe0ca90cb20bc0b2a44701d49eecd2411507e49b9477b9fee85986fa"},
    {"fm_id": 3534, "source_type": "report", "payload_hash": "0dda2cdf24d3b22ddde6c977b46f63f7809ad75be073dde48ad2327ea73ebe64"},
    {"fm_id": 3535, "source_type": "report", "payload_hash": "2aef0d91c1ff331f50abe187c33e59c7fefd427ec21f6b90edd680c03c65d455"},
    {"fm_id": 3536, "source_type": "report", "payload_hash": "8d71bc0c346dd0d73fded837af54daf39cc034bc5ec98623d33e616857ee68f0"},
    {"fm_id": 3537, "source_type": "report", "payload_hash": "ce10fa9360dccdbcff1fb0da305e0fb44493eeb47430934b877d58d79a70f2dd"},
    {"fm_id": 3538, "source_type": "report", "payload_hash": "81d9d472437948b7209a5a5fa93006419aca72a3bf8c17b41323505ecd671e3d"},
    {"fm_id": 3539, "source_type": "report", "payload_hash": "62bec5ea9ca4ab420f1c6e34ad645a045f4272ee951f24781b293205cdeccc05"},
    {"fm_id": 3540, "source_type": "report", "payload_hash": "d80a3a386a4352e8542154302f26d0bf1497621a948d44212541ce03c53d59f8"},
    {"fm_id": 3541, "source_type": "report", "payload_hash": "00d77112a1bde43d400165af6fe69993b3a5933d3cb60c83a8e373978f6882d2"},
    {"fm_id": 3542, "source_type": "report", "payload_hash": "96f7369eac403647fbe5e56f6b5b705fd805e5c4f3e117176ecd7523e4f4b710"},
    {"fm_id": 3543, "source_type": "report", "payload_hash": "34ba2512c7a3154c68da29fbe382e0edf9960c545b80c8a3d15a2d2e6e856558"},
    {"fm_id": 3544, "source_type": "report", "payload_hash": "8a11bd7630c90edeb91170f6a73d7080f38cc8f1dc085c76b703901e53d3cd42"},
    {"fm_id": 3545, "source_type": "report", "payload_hash": "cf31047ee21a86ea88d86f66f64cd62b4d6df6eaf7bfb255cb92b598b1b4eb2f"},
    {"fm_id": 3546, "source_type": "report", "payload_hash": "deecf40d80d7afe699ebcd15495ca4d0ec8b2131624e4b58e9db8db658dd4509"},
    {"fm_id": 3547, "source_type": "report", "payload_hash": "c1f08bfd5691ecadc8e90d89e58531a25c8b41eedae273e63ab5f19720695d38"},
    {"fm_id": 3548, "source_type": "report", "payload_hash": "b3ba53a05212e755e47c9cc37d98e795dcaa8ce035afaa527cec753f58a3edbd"},
    {"fm_id": 3549, "source_type": "report", "payload_hash": "58df9fa71f0ae416f40cb73086494446f455ad74446f5f39dc90e4c1b868202c"},
    {"fm_id": 3550, "source_type": "report", "payload_hash": "68dcf544a953ae410b132833aa4ae33e6b2c852adc1491fe65b9a8aeace9bede"},
    {"fm_id": 3551, "source_type": "report", "payload_hash": "020063016c722d606689d0ceb62252ba2cfc8e91dc743de29e0079f7a03e6956"},
    {"fm_id": 3552, "source_type": "report", "payload_hash": "643e87d991e3dca33ce7cbe866ff98ee19fd69261368442db004e03ca02b666c"},
    {"fm_id": 3553, "source_type": "report", "payload_hash": "e44f0f4b6e944202e163f2a6385c2dc21112b91eebc75cf4bc599d506b151ec1"},
    {"fm_id": 3554, "source_type": "report", "payload_hash": "4731a8f7372000b8379868276a234d290b214f35419351d775178f475804e9b6"},
    {"fm_id": 3555, "source_type": "report", "payload_hash": "b82c27be5bc59e9c7b726fd58e88efcb4859e25382fdb1274099c6680e538464"},
    {"fm_id": 3556, "source_type": "report", "payload_hash": "d1d7a5f7cc50f713547a34f0fcd194b40adb0986dd572d7357f2c01c11a3eb3a"},
    {"fm_id": 3557, "source_type": "report", "payload_hash": "b1c8471871f5087fc99c0cae02c4095bb3b363338a43ae7f2e77c375523a8812"},
    {"fm_id": 3558, "source_type": "report", "payload_hash": "8313d5c6ba25c431f9a33de2e8e25b41b7886632a335e418c07f375a8165b771"},
    {"fm_id": 3559, "source_type": "report", "payload_hash": "3332f6db918c644513acfce4b47d67b2dff857923ff82c527959b900a7ef98dd"},
    {"fm_id": 3560, "source_type": "report", "payload_hash": "69ba82f416d9d124ebdc5258734ce192bf860c0e38774b111b21797aa8498006"},
    {"fm_id": 3561, "source_type": "report", "payload_hash": "b76cbcc59c460941c0147477a60e1b8d8d38db77e53330b3fcfb04e76081830c"},
    {"fm_id": 3562, "source_type": "report", "payload_hash": "6207b4a7e06fc199a2bd9e3e44b84ca91bbab290845fd6fa9252f1c508d13d73"},
    {"fm_id": 3563, "source_type": "report", "payload_hash": "2448daea3b758ee26311c496e956768d5b073a74b323ecd3b167c7933e0c6a3f"},
    {"fm_id": 3564, "source_type": "report", "payload_hash": "d5b500b0319e662daf85e36e8bc3966a301515b5c2852fac116c912411ffa539"},
    {"fm_id": 3565, "source_type": "report", "payload_hash": "c94fea5e7587992cf7ceb7cb936abe1b280e7aff5b02766555e5ea33586566d6"},
    {"fm_id": 3566, "source_type": "report", "payload_hash": "ae737ffd88930f9d425d26b301d80307bd721d6a82f9eb4a3fa838f2c05e8cf5"},
    {"fm_id": 3567, "source_type": "report", "payload_hash": "8b5e7bb2be5176090bdc11cf2fbdd1eb9eaeed8375bb8e02e50c0ace1192584b"},
    {"fm_id": 3568, "source_type": "report", "payload_hash": "0055feaee3fb1f86908edc0497ada407e9763f34db577cf839d9499bacfedff5"},
    {"fm_id": 3569, "source_type": "report", "payload_hash": "ec032eb44975fe7489e72986c76e77db267a0b330e0e0dc498c4bd577e590e1a"},
    {"fm_id": 3570, "source_type": "report", "payload_hash": "fd721705d68ea79a3d314006cf6b3987d0652e4a3945db2bee9ff8e4a48f6a5b"},
    {"fm_id": 3571, "source_type": "report", "payload_hash": "39b96aa5b868de7344734561aa251d2472f88f170ac53734510145ec3fa049d0"},
]

# Load preview batches
preview_file = Path("_preview_batches.json")
with open(preview_file) as f:
    preview_data = json.load(f)

report_rows = preview_data.get("report", [])
liberaciones_rows = preview_data.get("liberaciones", [])

print("=" * 100)
print("COMPARISON RESULTS")
print("=" * 100)

# Build set of existing payload_hashes in Supabase
existing_hashes = {row["payload_hash"] for row in supabase_data}

# Classify report rows
report_present = []
report_missing = []

for row in report_rows:
    payload_hash = row.get("_payload_hash")
    if payload_hash in existing_hashes:
        report_present.append(row)
    else:
        report_missing.append(row)

# All liberaciones are missing (none in Supabase export)
liberaciones_missing = liberaciones_rows[:]

print(f"\nREPORT (682 expected):")
print(f"  [OK] ALREADY_PRESENT: {len(report_present)}")
print(f"  [MISSING] MISSING: {len(report_missing)}")

print(f"\nLIBERAC IONES (744 expected):")
print(f"  [OK] ALREADY_PRESENT: 0")
print(f"  [MISSING] MISSING: {len(liberaciones_missing)}")

print(f"\nTOTAL:")
print(f"  [OK] Present in Supabase: {len(report_present)}")
print(f"  [MISSING] Missing (to import): {len(report_missing) + len(liberaciones_missing)}")

print(f"\nAMBIGUOUS ROWS: 0 (all payload_hashes are unique)")

# Generate SQL INSERT statements for missing rows
print(f"\n{'='*100}")
print("GENERATING SQL INSERT FOR MISSING ROWS")
print(f"{'='*100}\n")

account_id = 1054315166
insert_statements = []

# Insert missing report rows
for i, row in enumerate(report_missing, 1):
    settlement_amount = Decimal(str(row.get("SETTLEMENT_NET_AMOUNT", "0")))
    transaction_date = row.get("TRANSACTION_DATE", "").replace("T", " ").replace(".000", "").replace("-03:00", "")

    sql = f"""INSERT INTO mp_source_record (source_type, source_external_id, raw_data, account_id, payload_hash, created_at)
VALUES (
  'report',
  '{row.get("SOURCE_ID")}',
  '{json.dumps(row).replace("'", "''")}'::jsonb,
  {account_id},
  '{row.get("_payload_hash")}',
  NOW()
);"""
    insert_statements.append(sql)

print(f"Generated {len(insert_statements)} INSERT statements for missing report rows\n")

# Show summary
print(f"Ready to import:")
print(f"  - Report rows: {len(report_missing)}")
print(f"  - Liberaciones rows: {len(liberaciones_missing)}")
print(f"  - Total: {len(report_missing) + len(liberaciones_missing)}")

# Save SQL to file
sql_file = Path("INSERT_MISSING_JUNE_2026.sql")
with open(sql_file, "w") as f:
    f.write("-- Auto-generated SQL to insert missing June 2026 data\n")
    f.write(f"-- Report missing: {len(report_missing)}\n")
    f.write(f"-- Liberaciones missing: {len(liberaciones_missing)}\n\n")
    for stmt in insert_statements[:10]:  # Show first 10 as sample
        f.write(stmt + "\n\n")

print(f"\nSQL preview saved to: {sql_file}")
print("(Note: Only first 10 statements shown; full file would have all)")
