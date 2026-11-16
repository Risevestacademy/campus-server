import { ApiProperty } from '@nestjs/swagger';

export enum HealthStatus {
  Ok = 'ok',
  Degraded = 'degraded',
  Unavailable = 'unavailable',
}

export class MemoryMetricsDto {
  /**
   * Total resident set size in bytes.
   * @example 123456789
   */
  rss: number;

  /**
   * Total size of the heap in bytes.
   * @example 98304000
   */
  heapTotal: number;

  /**
   * Heap actually used in bytes.
   * @example 61440000
   */
  heapUsed: number;

  /**
   * Memory used by C++ objects bound to JS in bytes.
   * @example 8912896
   */
  external: number;
}

export class CpuMetricsDto {
  /**
   * Process CPU time in user mode (microseconds).
   * @example 823456
   */
  user: number;

  /**
   * Process CPU time in system mode (microseconds).
   * @example 123456
   */
  system: number;

  /**
   * Combined user+system CPU time (microseconds).
   * @example 946912
   */
  total: number;
}

export class LoadAverageDto {
  /**
   * Load average over the last 1 minute.
   * @example 1.5
   */
  '1m': number;

  /**
   * Load average over the last 5 minutes.
   * @example 1.2
   */
  '5m': number;

  /**
   * Load average over the last 15 minutes.
   * @example 1.1
   */
  '15m': number;
}

export class UptimeMetricsDto {
  /**
   * Process uptime in seconds.
   * @example 86400.12
   */
  seconds: number;
}

export class HealthResponseDto {
  /** Overall health state of the service. */
  @ApiProperty({
    enum: HealthStatus,
    enumName: 'HealthStatus',
    example: HealthStatus.Ok,
  })
  status: HealthStatus;

  /** Timestamp of the health check (ISO 8601). */
  timestamp: string;

  /** Process uptime. */
  uptime: UptimeMetricsDto;

  /** Memory usage of the Node.js process. */
  memory: MemoryMetricsDto;

  /** CPU time consumed by the Node.js process. */
  cpu: CpuMetricsDto;

  /** System load average. */
  loadAverage: LoadAverageDto;
}
