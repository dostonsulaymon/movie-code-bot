import { Injectable } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { InputFile } from 'grammy';
import logger from '../../../shared/utils/logger';
import { BotService } from '../bot.service';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class BroadcastService {
  private bot: Bot<Context>;
  private readonly adminIds: number[];

  constructor(
    private botService: BotService,
    private readonly databaseService: DatabaseService,
  ) {
    this.bot = this.botService.getBot();
    this.adminIds = this.botService.getAdminIds();
  }

  async sendBroadcastToAllUsers(
    senderId: number,
    text: string,
    videoPath?: string,
    parseMode?: 'Markdown' | 'HTML',
  ): Promise<{ success: number; failed: number }> {
    if (!this.adminIds.includes(senderId)) {
      logger.warn(`Unauthorized broadcast attempt by user ${senderId}`);
    }

    const users = await this.databaseService.user.findMany();

    let successCount = 0;
    let failedCount = 0;
    let videoFileId: string | undefined;

    if (videoPath) {
      if (!fs.existsSync(videoPath)) {
        logger.error(`Video file not found at path: ${videoPath}`);
        throw new Error(`Video file not found at path: ${videoPath}`);
      }

      const stats = fs.statSync(videoPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      logger.info(
        `Preparing to broadcast video: ${path.basename(videoPath)} (${fileSizeMB} MB) to ${users.length} users`,
      );

      try {
        logger.info('Uploading video once to obtain file_id for reuse...');
        const testResult = await this.bot.api.sendVideo(
          this.adminIds[0],
          new InputFile(videoPath),
          {
            caption: 'Initial upload to obtain file_id',
          },
        );
        videoFileId = testResult.video.file_id;
        logger.info(`Successfully obtained video file_id: ${videoFileId}`);
      } catch (error) {
        logger.error('Failed to obtain video file_id:', error);
        logger.warn('Falling back to direct file uploads');
      }
    }

    logger.info(
      `Starting broadcast to ${users.length} users - Text length: ${text.length} chars` +
        (videoPath ? ` + Video attachment` : ''),
    );

    const startTime = Date.now();
    let lastProgressLog = Date.now();
    let usersProcessed = 0;

    for (const user of users) {
      try {
        if (user.telegramId) {
          if (
            Date.now() - lastProgressLog > 30000 ||
            usersProcessed % 100 === 0
          ) {
            const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
            const rate = (
              usersProcessed /
              ((Date.now() - startTime) / 1000)
            ).toFixed(1);
            logger.info(
              `Broadcast progress: ${usersProcessed}/${users.length} users (${elapsedMin} min) - ${rate} users/sec`,
            );
            lastProgressLog = Date.now();
          }

          if (videoPath && videoFileId) {
            await this.bot.api.sendVideo(user.telegramId, videoFileId, {
              caption: text,
              parse_mode: parseMode,
            });
            logger.debug(`Video sent to user ${user.telegramId} using file_id`);
          } else if (videoPath) {
            const videoStream = fs.createReadStream(videoPath);
            await this.bot.api.sendVideo(
              user.telegramId,
              new InputFile(videoStream),
              {
                caption: text,
                parse_mode: parseMode,
              },
            );
            logger.debug(
              `Video sent to user ${user.telegramId} (direct upload)`,
            );
          } else {
            await this.bot.api.sendMessage(user.telegramId, text, {
              parse_mode: parseMode,
            });
            logger.debug(`Message sent to user ${user.telegramId}`);
          }

          successCount++;
          usersProcessed++;
          await new Promise((resolve) => setTimeout(resolve, 200));
        } else {
          logger.warn(`User ${user.id} has no telegramId`);
          failedCount++;
        }
      } catch (error) {
        logger.error(
          `Failed to send broadcast to user ${user.telegramId}:`,
          error,
        );
        failedCount++;

        if (
          error instanceof Error &&
          error.message.includes('Too Many Requests')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          logger.warn('Rate limit hit, increased delay to 5 seconds');
        }
      }
    }

    const totalTime = ((Date.now() - startTime) / 60000).toFixed(1);
    logger.info(
      `Broadcast completed in ${totalTime} minutes: ${successCount} successful, ${failedCount} failed`,
    );
    return { success: successCount, failed: failedCount };
  }
}
