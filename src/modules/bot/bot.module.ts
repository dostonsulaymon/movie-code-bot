import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BroadcastService } from './broadcast/broadcast.service';
import { BroadcastHandler } from './broadcast/broadcast.handler';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [BotService, BroadcastService, BroadcastHandler],
  exports: [BotService, BroadcastService, BroadcastHandler],
})
export class BotModule {}
