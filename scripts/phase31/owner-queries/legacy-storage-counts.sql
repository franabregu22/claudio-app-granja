-- PHASE 31 — LEGACY Storage inventory, READ-ONLY, COUNTS ONLY (owner-run against the LEGACY project; D-PC-8).
-- Bucket names, public flag, object counts and total bytes. No object name / path is printed.
BEGIN TRANSACTION READ ONLY;
SELECT b.id AS bucket, b.public, count(o.id) AS objects,
       coalesce(sum((o.metadata->>'size')::bigint), 0) AS total_bytes
  FROM storage.buckets b LEFT JOIN storage.objects o ON o.bucket_id = b.id
 GROUP BY b.id, b.public ORDER BY b.id;
SELECT 'objects_without_bucket' AS metric, count(*) FROM storage.objects o WHERE NOT EXISTS (SELECT 1 FROM storage.buckets b WHERE b.id = o.bucket_id);
ROLLBACK;
