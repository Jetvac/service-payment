CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

-- Timescale Toolkit's default percentile_agg uses UddSketch. This schema keeps
-- the stricter requirement for T-Digest through tdigest + rollup + approx_percentile.
CREATE TABLE IF NOT EXISTS measurements_1min (
  bucket timestamptz NOT NULL,
  service_id text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  min_lat double precision,
  max_lat double precision,
  avg_lat double precision,
  p50 double precision,
  p95 double precision,
  p99 double precision,
  error_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  latency_digest TDigest,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, service_id)
);

SELECT create_hypertable(
  'measurements_1min',
  'bucket',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

ALTER TABLE measurements_1min SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'service_id',
  timescaledb.compress_orderby = 'bucket DESC'
);

DO $$
BEGIN
  PERFORM add_compression_policy('measurements_1min', INTERVAL '7 days');
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    IF SQLSTATE != '42710' THEN
      RAISE;
    END IF;
END
$$;

CREATE MATERIALIZED VIEW IF NOT EXISTS measurements_5min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '5 minutes', bucket) AS bucket,
  service_id,
  sum(count)::integer AS count,
  min(min_lat) AS min_lat,
  max(max_lat) AS max_lat,
  CASE
    WHEN sum(success_count) > 0 THEN sum(avg_lat * success_count) / sum(success_count)
    ELSE NULL
  END AS avg_lat,
  approx_percentile(0.50, rollup(latency_digest)) AS p50,
  approx_percentile(0.95, rollup(latency_digest)) AS p95,
  approx_percentile(0.99, rollup(latency_digest)) AS p99,
  sum(error_count)::integer AS error_count,
  sum(success_count)::integer AS success_count,
  rollup(latency_digest) AS latency_digest
FROM measurements_1min
GROUP BY 1, 2
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS measurements_1hour
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  service_id,
  sum(count)::integer AS count,
  min(min_lat) AS min_lat,
  max(max_lat) AS max_lat,
  CASE
    WHEN sum(success_count) > 0 THEN sum(avg_lat * success_count) / sum(success_count)
    ELSE NULL
  END AS avg_lat,
  approx_percentile(0.50, rollup(latency_digest)) AS p50,
  approx_percentile(0.95, rollup(latency_digest)) AS p95,
  approx_percentile(0.99, rollup(latency_digest)) AS p99,
  sum(error_count)::integer AS error_count,
  sum(success_count)::integer AS success_count,
  rollup(latency_digest) AS latency_digest
FROM measurements_5min
GROUP BY 1, 2
WITH NO DATA;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'measurements_5min',
    start_offset => INTERVAL '2 days',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    IF SQLSTATE != '42710' THEN
      RAISE;
    END IF;
END
$$;

DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'measurements_1hour',
    start_offset => INTERVAL '30 days',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    IF SQLSTATE != '42710' THEN
      RAISE;
    END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.measurements_raw') IS NOT NULL THEN
    PERFORM add_retention_policy('measurements_raw', INTERVAL '1 day');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipping raw measurements retention policy: %', SQLERRM;
END
$$;
