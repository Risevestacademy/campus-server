import { Injectable } from '@nestjs/common';
import { loadavg } from 'node:os';

import { HealthResponseDto, HealthStatus } from './health-response.dto.js';

/**
 * Returns process-level health and performance data. Purely host-local, no
 * message wrapper — the response is the data itself.
 */
@Injectable()
export class HealthService {
  check(): HealthResponseDto {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const [l1m, l5m, l15m] = loadavg();

    return {
      status: HealthStatus.Ok,
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: process.uptime(),
      },
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      cpu: {
        user: cpu.user,
        system: cpu.system,
        total: cpu.user + cpu.system,
      },
      loadAverage: {
        '1m': l1m,
        '5m': l5m,
        '15m': l15m,
      },
    };
  }
}