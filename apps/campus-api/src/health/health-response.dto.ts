import { ApiProperty } from '@nestjs/swagger';

export enum HealthStatus {
  Ok = 'ok',
  Degraded = 'degraded',
  Unavailable = 'unavailable',
}

export class MemoryMetricsDto {
  @ApiProperty({ description: 'Total resident set size in bytes.', example: 123_456_789 })
  rss: number;

  @ApiProperty({ description: 'Total size of the heap in bytes.', example: 98_304_000 })
  heapTotal: number;

  @ApiProperty({ description: 'Heap actually used in bytes.', example: 61_440_000 })
  heapUsed: number;

  @ApiProperty({ description: 'Memory used by C++ objects bound to JS in bytes.', example: 8_912_896 })
  external: number;
}

export class CpuMetricsDto {
  @ApiProperty({ description: 'Process CPU time in user mode (microseconds).', example: 823_456 })
  user: number;

  @ApiProperty({ description: 'Process CPU time in system mode (microseconds).', example: 123_456 })
  system: number;

  @ApiProperty({ description: 'Combined user+system CPU time (microseconds).', example: 946_912 })
  total: number;
}

export class LoadAverageDto {
  @ApiProperty({ description: 'Load average over the last 1 minute.', example: 1.5 })
  '1m': number;

  @ApiProperty({ description: 'Load average over the last 5 minutes.', example: 1.2 })
  '5m': number;

  @ApiProperty({ description: 'Load average over the last 15 minutes.', example: 1.1 })
  '15m': number;
}

export class UptimeMetricsDto {
  @ApiProperty({ description: 'Process uptime in seconds.', example: 86400.12 })
  seconds: number;
}

export class HealthResponseDto {
  @ApiProperty({
    enum: HealthStatus,
    enumName: 'HealthStatus',
    description: 'Overall health state of the service.',
    example: HealthStatus.Ok,
  })
  status: HealthStatus;

  @ApiProperty({ description: 'Timestamp of the health check (ISO 8601).', type: String })
  timestamp: string;

  @ApiProperty({ description: 'Process uptime.', type: UptimeMetricsDto })
  uptime: UptimeMetricsDto;

  @ApiProperty({ description: 'Memory usage of the Node.js process.', type: MemoryMetricsDto })
  memory: MemoryMetricsDto;

  @ApiProperty({ description: 'CPU time consumed by the Node.js process.', type: CpuMetricsDto })
  cpu: CpuMetricsDto;

  @ApiProperty({ description: 'System load average.', type: LoadAverageDto })
  loadAverage: LoadAverageDto;
}