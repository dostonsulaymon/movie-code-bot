import { Injectable, OnModuleInit } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import logger from '../../shared/utils/logger';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly bot: Bot<Context>;
  private readonly adminIds: number[] = [ADMIN_ID_REDACTED];

  constructor(private readonly databaseService: DatabaseService) {
    this.bot = new Bot<Context>(process.env.BOT_TOKEN || '');
  }

  getBot(): Bot<Context> {
    return this.bot;
  }

  getAdminIds(): number[] {
    return this.adminIds;
  }

  async onModuleInit() {
    this.setupHandlers();
    this.bot.start().catch((err) => logger.error('Failed to start bot: ', err));
  }

  private setupHandlers(): void {
    this.bot.command('start', this.handleStart.bind(this));
  }

  private async handleStart(ctx: Context): Promise<void> {
    await this.createUserIfNotExist(ctx);
  }

  private async createUserIfNotExist(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!telegramId) {
      return;
    }

    const user = await this.databaseService.users.findFirst({
      where: {
        telegramId: telegramId,
      },
    });
    if (!user) {
      const newUser = await this.databaseService.users.create({
        data: {
          telegramId: telegramId,
          username: username,
        },
      });

      logger.info(`New user created  ${newUser}`);
    } else if (username && user.username !== username) {
      user.username = username;
      await this.databaseService.users.update({
        where: {
          telegramId: telegramId,
        },
        data: {
          username: username,
        },
      });
    }
  }

  // Method to register broadcast command - called by BroadcastHandler
  registerBroadcastCommand(handler: (ctx: Context) => Promise<void>): void {
    this.bot.command('broadcast', handler);
  }
}
