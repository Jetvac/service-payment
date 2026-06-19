import pg from "pg";
import type { Pool as PoolType } from "pg";
import type { AppData, LatencyCheck, ServiceHealthStatus } from "./types";

const { Pool } = pg;

type LatencyMeasurementInput = {
  serviceId: string;
  latencyMs: number | null;
  status: ServiceHealthStatus;
  error: string;
  checkedAt: string;
};

type MinuteAggregate = {
  bucket: Date;
  serviceId: string;
  count: number;
  minLat: number | null;
  maxLat: number | null;
  avgLat: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  errorCount: number;
  successCount: number;
  samples: number[];
};

type LatencyChartResult = {
  latencyTimeline: Array<Record<string, string | number>>;
  latencySeries: Array<{ key: string; name: string; color: string }>;
};

type AggregateRow = {
  bucket: Date;
  service_id: string;
  count: string | number;
  min_lat: string | number | null;
  max_lat: string | number | null;
  avg_lat: string | number | null;
  p50: string | number | null;
  p95: string | number | null;
  p99: string | number | null;
  error_count: string | number;
  success_count: string | number;
};

type ChartRow = {
  bucket: Date;
  service_id: string;
  avg_lat: string | number | null;
};

const latencyLineColors = ["#7aa8ff", "#47d18c", "#f8c15d", "#ff8b82", "#b994ff", "#5ed4d6", "#f49ac2", "#c6cad2"];
const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

function roundMetric(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function numberOrNull(value: string | number | null) {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function readTime(value: unknown) {
  const raw = String(value ?? "");
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function latencyBucketSize(rangeMs: number) {
  if (rangeMs <= 2 * dayMs) return 30 * minuteMs;
  if (rangeMs <= 14 * dayMs) return 6 * hourMs;
  if (rangeMs <= 90 * dayMs) return dayMs;
  if (rangeMs <= 370 * dayMs) return 7 * dayMs;
  return 31 * dayMs;
}

function bucketInterval(bucketSize: number) {
  return `${Math.max(1, Math.floor(bucketSize / 1000))} seconds`;
}

function latencyBucketLabel(bucketTime: number, bucketSize: number) {
  const date = new Date(bucketTime);
  if (bucketSize < dayMs) {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
}

class TDigest {
  private centroids: Array<{ mean: number; count: number }> = [];
  private total = 0;

  constructor(private readonly compression = 100) {}

  add(value: number) {
    if (!Number.isFinite(value)) return;
    this.centroids.push({ mean: value, count: 1 });
    this.total += 1;
    if (this.centroids.length > this.compression * 8) this.compress();
  }

  percentile(q: number) {
    if (this.total === 0) return null;
    this.compress();
    const target = Math.max(0, Math.min(1, q)) * (this.total - 1);
    let seen = 0;
    for (const centroid of this.centroids) {
      const next = seen + centroid.count;
      if (target < next) return centroid.mean;
      seen = next;
    }
    return this.centroids[this.centroids.length - 1]?.mean ?? null;
  }

  private compress() {
    if (this.centroids.length <= 1) return;
    this.centroids.sort((a, b) => a.mean - b.mean);
    const maxWeight = Math.max(1, Math.ceil(this.total / this.compression));
    const merged: Array<{ mean: number; count: number }> = [];

    for (const centroid of this.centroids) {
      const current = merged[merged.length - 1];
      if (current && current.count + centroid.count <= maxWeight) {
        const count = current.count + centroid.count;
        current.mean = (current.mean * current.count + centroid.mean * centroid.count) / count;
        current.count = count;
      } else {
        merged.push({ ...centroid });
      }
    }

    this.centroids = merged;
  }
}

class MinuteAccumulator {
  count = 0;
  errorCount = 0;
  successCount = 0;
  sum = 0;
  min: number | null = null;
  max: number | null = null;
  flushed = false;
  dirty = false;

  private readonly digest = new TDigest(100);
  private readonly samples: number[] = [];

  constructor(
    readonly serviceId: string,
    readonly bucketMs: number
  ) {}

  add(input: LatencyMeasurementInput) {
    this.count += 1;
    const isSuccess = input.status === "online" && input.latencyMs !== null && Number.isFinite(input.latencyMs);
    if (!isSuccess) {
      this.errorCount += 1;
      this.dirty = true;
      return;
    }

    const latency = Math.max(0, Number(input.latencyMs));
    this.successCount += 1;
    this.sum += latency;
    this.min = this.min === null ? latency : Math.min(this.min, latency);
    this.max = this.max === null ? latency : Math.max(this.max, latency);
    this.digest.add(latency);
    this.samples.push(latency);
    this.dirty = true;
  }

  toAggregate(): MinuteAggregate {
    return {
      bucket: new Date(this.bucketMs),
      serviceId: this.serviceId,
      count: this.count,
      minLat: roundMetric(this.min),
      maxLat: roundMetric(this.max),
      avgLat: this.successCount > 0 ? roundMetric(this.sum / this.successCount) : null,
      p50: roundMetric(this.digest.percentile(0.5)),
      p95: roundMetric(this.digest.percentile(0.95)),
      p99: roundMetric(this.digest.percentile(0.99)),
      errorCount: this.errorCount,
      successCount: this.successCount,
      samples: [...this.samples]
    };
  }
}

export class LatencyAggregator {
  readonly enabled: boolean;

  private readonly databaseUrl: string;
  private readonly settleMs: number;
  private readonly lateGraceMs: number;
  private readonly pool: PoolType | null;
  private readonly buckets = new Map<string, MinuteAccumulator>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain = Promise.resolve();

  constructor() {
    this.databaseUrl = process.env.TIMESCALE_DATABASE_URL || process.env.DATABASE_URL || "";
    this.enabled = Boolean(this.databaseUrl);
    this.settleMs = Math.max(1000, Number(process.env.LATENCY_AGGREGATION_SETTLE_MS ?? 5000));
    this.lateGraceMs = Math.max(minuteMs, Number(process.env.LATENCY_LATE_GRACE_MS ?? 2 * minuteMs));
    this.pool = this.enabled
      ? new Pool({
          connectionString: this.databaseUrl,
          max: Math.max(1, Number(process.env.TIMESCALE_POOL_SIZE ?? 4))
        })
      : null;
  }

  start() {
    if (!this.enabled || this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.queueFlush();
    }, Math.max(5000, Number(process.env.LATENCY_AGGREGATION_FLUSH_MS ?? 10000)));
    this.flushTimer.unref?.();
  }

  async stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.queueFlush(true);
    await this.pool?.end();
  }

  async record(input: LatencyMeasurementInput) {
    if (!this.enabled) return false;

    try {
      const checkedAt = new Date(input.checkedAt).getTime();
      if (!Number.isFinite(checkedAt)) return false;

      const now = Date.now();
      const bucketMs = Math.floor(checkedAt / minuteMs) * minuteMs;
      const isTooLate = bucketMs + minuteMs + this.lateGraceMs < now;
      if (isTooLate) return false;

      const key = `${input.serviceId}:${bucketMs}`;
      const accumulator = this.buckets.get(key) ?? new MinuteAccumulator(input.serviceId, bucketMs);
      accumulator.add(input);
      this.buckets.set(key, accumulator);
      void this.queueFlush();
      return true;
    } catch (error) {
      console.error("Failed to aggregate latency measurement", error);
      return false;
    }
  }

  async queryMinuteRows(offset: number, limit: number) {
    if (!this.pool) return { rows: [] as Array<LatencyCheck & Record<string, unknown>>, total: 0, offset, limit, hasMore: false };

    const [rowsResult, countResult] = await Promise.all([
      this.pool.query<AggregateRow>(
        `SELECT bucket, service_id, count, min_lat, max_lat, avg_lat, p50, p95, p99, error_count, success_count
         FROM measurements_1min
         ORDER BY bucket DESC
         OFFSET $1 LIMIT $2`,
        [offset, limit]
      ),
      this.pool.query<{ total: string }>("SELECT count(*) AS total FROM measurements_1min")
    ]);

    const rows = rowsResult.rows.map((row) => {
      const avg = numberOrNull(row.avg_lat);
      const errorCount = Number(row.error_count);
      const successCount = Number(row.success_count);
      const status: ServiceHealthStatus = successCount > 0 && errorCount === 0 ? "online" : successCount > 0 ? "unknown" : "offline";
      return {
        id: `${row.service_id}:${new Date(row.bucket).toISOString()}`,
        serviceId: row.service_id,
        userId: null,
        status,
        latencyMs: avg === null ? null : Math.round(avg),
        checkedAt: new Date(row.bucket).toISOString(),
        error: errorCount > 0 ? `Ошибок: ${errorCount}, успешных: ${successCount}` : "",
        createdAt: new Date(row.bucket).toISOString(),
        count: Number(row.count),
        minLat: numberOrNull(row.min_lat),
        maxLat: numberOrNull(row.max_lat),
        avgLat: avg,
        p50: numberOrNull(row.p50),
        p95: numberOrNull(row.p95),
        p99: numberOrNull(row.p99),
        errorCount,
        successCount
      };
    });
    const total = Number(countResult.rows[0]?.total ?? rows.length);

    return {
      rows,
      total,
      offset,
      limit,
      hasMore: offset + limit < total
    };
  }

  async queryChart(data: AppData, query: Record<string, unknown>): Promise<LatencyChartResult> {
    if (!this.pool) return { latencyTimeline: [], latencySeries: [] };

    const to = readTime(query.to) ?? Date.now();
    const from = readTime(query.from) ?? to - 7 * dayMs;
    const rangeMs = Math.max(1, to - from);
    const bucketSize = latencyBucketSize(rangeMs);
    const source = rangeMs <= 2 * dayMs ? "measurements_1min" : rangeMs <= 90 * dayMs ? "measurements_5min" : "measurements_1hour";
    const serviceNames = new Map(data.services.map((service) => [service.id, service.name]));

    const result = await this.pool.query<ChartRow>(
      `SELECT time_bucket($1::interval, bucket) AS bucket,
              service_id,
              CASE
                WHEN sum(success_count) > 0 THEN sum(avg_lat * success_count) / sum(success_count)
                ELSE NULL
              END AS avg_lat
       FROM ${source}
       WHERE bucket >= $2::timestamptz AND bucket <= $3::timestamptz
       GROUP BY 1, 2
       ORDER BY 1 ASC`,
      [bucketInterval(bucketSize), new Date(from).toISOString(), new Date(to).toISOString()]
    );

    const latencySeries: Array<{ key: string; name: string; color: string }> = [];
    const latencySeriesByService = new Map<string, { key: string; name: string; color: string }>();
    const latencyBuckets = new Map<string, { time: string; ts: number; values: Record<string, number> }>();

    for (const row of result.rows) {
      const avg = numberOrNull(row.avg_lat);
      if (avg === null) continue;

      let series = latencySeriesByService.get(row.service_id);
      if (!series && latencySeries.length < latencyLineColors.length) {
        series = {
          key: `latency_${latencySeries.length}`,
          name: serviceNames.get(row.service_id) ?? "Сервис",
          color: latencyLineColors[latencySeries.length]
        };
        latencySeriesByService.set(row.service_id, series);
        latencySeries.push(series);
      }
      if (!series) continue;

      const bucketMs = new Date(row.bucket).getTime();
      const bucketId = String(bucketMs);
      const bucket =
        latencyBuckets.get(bucketId) ??
        {
          time: latencyBucketLabel(bucketMs, bucketSize),
          ts: bucketMs,
          values: {}
        };
      bucket.values[series.key] = Math.round(avg);
      latencyBuckets.set(bucketId, bucket);
    }

    return {
      latencyTimeline: Array.from(latencyBuckets.values())
        .sort((a, b) => a.ts - b.ts)
        .slice(-160)
        .map((bucket) => ({ time: bucket.time, ...bucket.values })),
      latencySeries
    };
  }

  private queueFlush(force = false) {
    this.flushChain = this.flushChain
      .then(() => this.flushClosed(Date.now(), force))
      .catch((error) => {
        console.error("Failed to flush latency aggregates", error);
      });
    return this.flushChain;
  }

  private async flushClosed(now: number, force = false) {
    if (!this.pool) return;

    for (const [key, accumulator] of this.buckets) {
      const closedAt = accumulator.bucketMs + minuteMs + this.settleMs;
      const expiredAt = accumulator.bucketMs + minuteMs + this.lateGraceMs;
      const shouldFlush = force || (closedAt <= now && accumulator.dirty);
      if (shouldFlush) {
        await this.upsertMinuteAggregate(accumulator.toAggregate());
        accumulator.flushed = true;
        accumulator.dirty = false;
      }
      if (accumulator.flushed && expiredAt < now && !accumulator.dirty) {
        this.buckets.delete(key);
      }
    }
  }

  private async upsertMinuteAggregate(aggregate: MinuteAggregate) {
    if (!this.pool || aggregate.count <= 0) return;

    await this.pool.query(
      `WITH input_values(value) AS (
         SELECT unnest($9::double precision[])
       ),
       digest AS (
         SELECT tdigest($10::integer, value) AS latency_digest
         FROM input_values
       )
       INSERT INTO measurements_1min (
         bucket, service_id, count, min_lat, max_lat, avg_lat, p50, p95, p99, error_count, success_count, latency_digest, updated_at
       )
       SELECT $1::timestamptz, $2::text, $3::integer, $4::double precision, $5::double precision, $6::double precision,
              approx_percentile(0.50, latency_digest),
              approx_percentile(0.95, latency_digest),
              approx_percentile(0.99, latency_digest),
              $7::integer, $8::integer,
              latency_digest, now()
       FROM digest
       ON CONFLICT (bucket, service_id) DO UPDATE SET
         count = EXCLUDED.count,
         min_lat = EXCLUDED.min_lat,
         max_lat = EXCLUDED.max_lat,
         avg_lat = EXCLUDED.avg_lat,
         p50 = EXCLUDED.p50,
         p95 = EXCLUDED.p95,
         p99 = EXCLUDED.p99,
         error_count = EXCLUDED.error_count,
         success_count = EXCLUDED.success_count,
         latency_digest = EXCLUDED.latency_digest,
         updated_at = now()`,
      [
        aggregate.bucket.toISOString(),
        aggregate.serviceId,
        aggregate.count,
        aggregate.minLat,
        aggregate.maxLat,
        aggregate.avgLat,
        aggregate.errorCount,
        aggregate.successCount,
        aggregate.samples,
        100
      ]
    );
  }
}

export const latencyAggregator = new LatencyAggregator();
