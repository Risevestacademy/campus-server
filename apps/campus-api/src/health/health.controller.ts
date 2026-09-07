import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiErrorResponseDto } from '../shared/dto/api-error-response.dto.js';
import { HealthResponseDto } from './health-response.dto.js';
import { HealthService } from './health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Health and performance check',
    description: 'Returns process status, uptime, memory, CPU and load averages.',
  })
  @ApiOkResponse({ description: 'The service is healthy.', type: HealthResponseDto })
  @ApiResponse({
    status: 500,
    description: 'The service failed to produce a health check.',
    type: ApiErrorResponseDto,
  })
  check(): HealthResponseDto {
    return this.healthService.check();
  }
}