import { Module } from '@nestjs/common';

import { AdminGuard } from '../../shared/auth/admin.guard.js';
import { fetchWithTimeout } from '../../shared/http/fetch-with-timeout.js';
import { SessionModule } from '../auth/session.module.js';
import { MapPublishService } from './map-publish.service.js';
import { MapSyncService } from './map-sync.service.js';
import { MapsController } from './maps.controller.js';
import { MAPS_FETCH, PublishedMapsReader } from './published-maps.js';
import { SpaceMembershipsController } from './space-memberships.controller.js';
import { SpaceMembershipsService } from './space-memberships.service.js';
import { SpacesController } from './spaces.controller.js';
import { SpacesService } from './spaces.service.js';
import { MAPS_NOTIFY, tellWorldMap } from './tell-world.js';

@Module({
  imports: [SessionModule],
  controllers: [MapsController, SpaceMembershipsController, SpacesController],
  providers: [
    MapPublishService,
    MapSyncService,
    SpaceMembershipsService,
    SpacesService,
    PublishedMapsReader,
    // Its own provider so a test can answer for Sanity without a network.
    { provide: MAPS_FETCH, useValue: fetchWithTimeout },
    // And one so a test can make the notification fail on its own.
    { provide: MAPS_NOTIFY, useValue: tellWorldMap },
    AdminGuard,
  ],
})
export class MapsModule {}
