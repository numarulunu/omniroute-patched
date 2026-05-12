-- Make API-key request policy explicit for existing self-hosted keys.
-- Previously, NULL policy fields inherited a hidden 1k/day code default.
UPDATE api_keys
SET max_requests_per_day = 100000,
    max_requests_per_minute = 600,
    rate_limits = '[{"limit":100000,"window":86400},{"limit":500000,"window":604800},{"limit":2000000,"window":2592000}]'
WHERE rate_limits IS NULL
  AND max_requests_per_day IS NULL
  AND max_requests_per_minute IS NULL;
