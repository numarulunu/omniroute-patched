-- Persist retry bookkeeping for expired OAuth accounts so health checks can back off.
ALTER TABLE provider_connections ADD COLUMN expired_retry_count INTEGER DEFAULT 0;
ALTER TABLE provider_connections ADD COLUMN expired_retry_at TEXT;