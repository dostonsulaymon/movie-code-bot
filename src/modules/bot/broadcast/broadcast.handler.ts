import { Injectable, OnModuleInit } from '@nestjs/common';
import { Context } from 'grammy';
import * as path from 'path';
import { BroadcastService } from './broadcast.service';
import { BotService } from '../bot.service';
import logger from '../../../shared/utils/logger';

@Injectable()
export class BroadcastHandler implements OnModuleInit {
  constructor(
    private broadcastService: BroadcastService,
    private botService: BotService,
  ) {}

  async onModuleInit() {
    this.botService.registerBroadcastCommand(
      this.handleBroadcastCommand.bind(this),
    );
  }

  async handleBroadcastCommand(ctx: Context): Promise<void> {
    const senderId = ctx.from?.id;
    const senderUsername = ctx.from?.username || 'unknown';

    if (!this.botService.getAdminIds().includes(senderId)) {
      logger.warn('Broadcast command from unidentified sender');
      return;
    }

    logger.info(
      `Broadcast command received from @${senderUsername} (${senderId})`,
    );

    const args = ctx.message?.text?.split(' ').slice(1).join(' ') || '';

    if (!args) {
      logger.info('Broadcast command with empty message');
      await ctx.reply(
        '⚠️ Please provide a message to broadcast.\n\n' +
          'Usage:\n' +
          '- Text only: `/broadcast Your message here`\n' +
          '- With video: `/broadcast Your message here --video=filename.mp4`',
      );
      return;
    }

    try {
      const videoMatch = args.match(/123video=(\S+)/i);
      let videoPath: string | undefined;
      let messageText = args;

      if (videoMatch) {
        const videoFilename = videoMatch[1];
        messageText = args.replace(/123video=(\S+)/i, '').trim();
        videoPath = path.join(process.cwd(), 'videos', videoFilename);
      }

      const formattedMessage = messageText;

      logger.info(
        `Broadcasting formatted message: ${formattedMessage.substring(0, 50)}...`,
      );

      const result = await this.broadcastService.sendBroadcastToAllUsers(
        senderId,
        formattedMessage,
        videoPath,
        'Markdown',
      );

      const completionMessage =
        `✅ Broadcast complete!\n\n` +
        `📊 Statistics:\n` +
        `- Successfully sent: ${result.success}\n` +
        `- Failed: ${result.failed}`;

      logger.info(
        `Broadcast completed - Success: ${result.success}, Failed: ${result.failed}`,
      );
      await ctx.reply(completionMessage);
    } catch (error) {
      logger.error('Broadcast command error:', error);
      await ctx.reply(
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
