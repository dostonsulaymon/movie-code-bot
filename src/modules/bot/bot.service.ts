import { Injectable, OnModuleInit } from '@nestjs/common';
import { Bot, Context, InlineKeyboard } from 'grammy';
import logger from '../../shared/utils/logger';
import { DatabaseService } from '../database/database.service';
import * as process from 'node:process';

interface PendingMovie {
  fileId: string;
  title: string;
  userId: number;
  timestamp: number;
}

interface AdminSession {
  isInAdminMode: boolean;
  awaitingMovieCode?: boolean;
  pendingMovie?: PendingMovie;
  awaitingNewAdminId?: boolean;
}

@Injectable()
export class BotService implements OnModuleInit {
  private readonly bot: Bot<Context>;
  private readonly sourceChannelIdUZ: string = process.env.CHANNEL_UZ_ID;
  public superAdminIds: number[] = [ADMIN_ID_REDACTED, ADMIN_ID_REDACTED]; // Super admins
  private adminSessions: Map<number, AdminSession> = new Map();

  constructor(private readonly databaseService: DatabaseService) {
    this.bot = new Bot<Context>(process.env.BOT_TOKEN || '');
  }

  getBot(): Bot<Context> {
    return this.bot;
  }

  async onModuleInit() {
    this.setupHandlers();
    this.bot.start().catch((err) => logger.error('Failed to start bot: ', err));
  }

  private setupHandlers(): void {
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('admin', this.handleAdminCommand.bind(this));
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    this.bot.on('message', this.handleMessage.bind(this));
  }

  private async handleStart(ctx: Context): Promise<void> {
    await this.createUserIfNotExist(ctx);
    await this.showIntro(ctx);
  }

  private async handleAdminCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !(await this.isAdmin(userId))) {
      await ctx.reply('❌ Bu buyruq faqat adminlar uchun!');
      return;
    }

    const session = this.getOrCreateSession(userId);
    session.isInAdminMode = true;

    const keyboard = new InlineKeyboard()
      .text("📹 Kino qo'shish", 'add_movie')
      .row()
      .text("🗑 Kino o'chirish", 'remove_movie')
      .row();

    if (this.isSuperAdmin(userId)) {
      keyboard.text("👤 Admin qo'shish", 'add_admin').row();
    }

    keyboard.text('❌ Admin rejimdan chiqish', 'exit_admin');

    await ctx.reply(
      '🔧 <b>Admin rejimi faollashtirildi!</b>\n\n' +
        'Quyidagi tugmalardan birini tanlang:',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      },
    );
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery?.data;
    const userId = ctx.from?.id;

    if (!userId || !callbackData) return;

    await ctx.answerCallbackQuery();

    const session = this.getOrCreateSession(userId);

    switch (callbackData) {
      case 'add_movie':
        await this.handleAddMovieCallback(ctx, session);
        break;
      case 'remove_movie':
        await this.handleRemoveMovieCallback(ctx);
        break;
      case 'add_admin':
        if (this.isSuperAdmin(userId)) {
          await this.handleAddAdminCallback(ctx, session);
        }
        break;
      case 'exit_admin':
        await this.handleExitAdminCallback(ctx, userId);
        break;
    }
  }

  private async handleAddMovieCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    await ctx.editMessageText(
      "📹 <b>Kino qo'shish</b>\n\n" +
        'Iltimos kanaldan kinoni forward qiling yoki video/hujjat yuboring:',
      { parse_mode: 'HTML' },
    );
  }

  private async handleRemoveMovieCallback(ctx: Context): Promise<void> {
    await ctx.editMessageText(
      "🗑 <b>Kino o'chirish</b>\n\n" +
        "O'chirmoqchi bo'lgan kino kodini yuboring:",
      { parse_mode: 'HTML' },
    );
  }

  private async handleAddAdminCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    session.awaitingNewAdminId = true;
    await ctx.editMessageText(
      "👤 <b>Admin qo'shish</b>\n\n" +
        "Yangi admin bo'lishi kerak bo'lgan foydalanuvchi ID sini yuboring:",
      { parse_mode: 'HTML' },
    );
  }

  private async handleExitAdminCallback(
    ctx: Context,
    userId: number,
  ): Promise<void> {
    this.adminSessions.delete(userId);
    await ctx.editMessageText('❌ Admin rejimdan chiqdingiz!');
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = this.adminSessions.get(userId);

    // If user is in admin mode, handle admin actions
    if (session?.isInAdminMode) {
      await this.handleAdminMessage(ctx, session);
      return;
    }

    // Regular user flow
    await this.handleRegularUserMessage(ctx);
  }

  private async handleAdminMessage(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    const msg = ctx.message;
    const userId = ctx.from?.id;

    // Handle new admin ID input
    if (session.awaitingNewAdminId && msg.text) {
      await this.processNewAdminId(ctx, msg.text, session);
      return;
    }

    // Handle movie code input for pending movie
    if (session.awaitingMovieCode && msg.text) {
      await this.processMovieCode(ctx, msg.text, session);
      return;
    }

    // Handle forwarded messages or direct video/document uploads
    const forwardedFromChannelId = (msg as any).forward_from_chat?.id;
    if (
      forwardedFromChannelId == this.sourceChannelIdUZ ||
      msg.video ||
      msg.document
    ) {
      await this.processMovieUpload(ctx, session);
      return;
    }

    // Handle movie removal by code
    if (msg.text && /^\d{1,4}$/.test(msg.text.trim())) {
      await this.processMovieRemoval(ctx, msg.text.trim());
      return;
    }

    await ctx.reply(
      "❌ Noto'g'ri format! Admin rejimdan chiqish uchun /admin buyrug'ini ishlating.",
    );
  }

  private async processNewAdminId(
    ctx: Context,
    adminIdText: string,
    session: AdminSession,
  ): Promise<void> {
    const newAdminId = parseInt(adminIdText.trim());

    if (isNaN(newAdminId)) {
      await ctx.reply("❌ Noto'g'ri ID format!");
      return;
    }

    // Check if already admin
    const existingAdmin = await this.databaseService.admin.findFirst({
      where: { userId: newAdminId.toString() },
    });

    if (existingAdmin) {
      await ctx.reply('❌ Bu foydalanuvchi allaqachon admin!');
      return;
    }

    // Add new admin
    await this.databaseService.admin.create({
      data: { userId: newAdminId.toString() },
    });

    session.awaitingNewAdminId = false;

    await ctx.reply(
      `✅ Yangi admin muvaffaqiyatli qo'shildi!\n\n` +
        `👤 Admin ID: <code>${newAdminId}</code>`,
      { parse_mode: 'HTML' },
    );

    // Show admin menu again
    await this.showAdminMenu(ctx);
  }

  private async processMovieCode(
    ctx: Context,
    code: string,
    session: AdminSession,
  ): Promise<void> {
    const pendingMovie = session.pendingMovie;
    if (!pendingMovie) {
      await ctx.reply("❌ Kutilayotgan kino ma'lumoti topilmadi!");
      return;
    }

    if (!/^\d{1,4}$/.test(code)) {
      await ctx.reply("❌ Kino kodi 1-4 raqamdan iborat bo'lishi kerak!");
      return;
    }

    // Check if code exists
    const existingMovie = await this.databaseService.movie.findFirst({
      where: { code: code },
    });

    if (existingMovie) {
      await ctx.reply(
        `❌ ${code} kodi allaqachon ishlatilgan! Boshqa kod kiriting.`,
      );
      return;
    }

    // Save movie
    await this.saveMovie(ctx, pendingMovie, code, session);
  }

  private async processMovieUpload(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    const msg = ctx.message;
    let fileId = '';
    let title = '';

    if (msg.video) {
      fileId = msg.video.file_id;
    } else if (msg.document) {
      fileId = msg.document.file_id;
    } else {
      await ctx.reply('❌ Faqat video yoki hujjat yuborish mumkin!');
      return;
    }

    // Extract title
    if (msg.caption) {
      const lines = msg.caption.split('\n');
      title = lines[0] || 'Unknown Movie';
    } else {
      title = 'Unknown Movie';
    }

    session.pendingMovie = {
      fileId: fileId,
      title: title,
      userId: ctx.from?.id,
      timestamp: Date.now(),
    };
    session.awaitingMovieCode = true;

    await ctx.reply(
      `🎬 Kino: <b>${title}</b>\n\n` +
        `📝 Iltimos bu kino uchun 1-4 raqamli kod yuboring:`,
      { parse_mode: 'HTML' },
    );
  }

  private async processMovieRemoval(ctx: Context, code: string): Promise<void> {
    const movie = await this.databaseService.movie.findFirst({
      where: { code: code },
    });

    if (!movie) {
      await ctx.reply(`❌ ${code} kodli kino topilmadi!`);
      return;
    }

    await this.databaseService.movie.delete({
      where: { id: movie.id },
    });

    await ctx.reply(
      `✅ Kino muvaffaqiyatli o'chirildi!\n\n` +
        `🎬 Nomi: <b>${movie.title}</b>\n` +
        `🔢 Kod: <b>${code}</b>`,
      { parse_mode: 'HTML' },
    );

    await this.showAdminMenu(ctx);
  }

  private async saveMovie(
    ctx: Context,
    pendingMovie: PendingMovie,
    code: string,
    session: AdminSession,
  ): Promise<void> {
    try {
      const userId = ctx.from?.id;

      // Find or create admin record
      let admin = await this.databaseService.admin.findFirst({
        where: { userId: userId.toString() },
      });

      if (!admin) {
        admin = await this.databaseService.admin.create({
          data: { userId: userId.toString() },
        });
      }

      const movie = await this.databaseService.movie.create({
        data: {
          code: code,
          title: pendingMovie.title,
          fileId: pendingMovie.fileId,
          addedBy: admin.id,
        },
      });

      session.awaitingMovieCode = false;
      session.pendingMovie = undefined;

      await ctx.reply(
        `✅ Kino muvaffaqiyatli saqlandi!\n\n` +
          `🎬 Nomi: <b>${pendingMovie.title}</b>\n` +
          `🔢 Kod: <b>${code}</b>`,
        { parse_mode: 'HTML' },
      );

      logger.info(`Movie saved: ${movie.title} with code ${movie.code}`);

      // Show admin menu again
      await this.showAdminMenu(ctx);
    } catch (error) {
      await ctx.reply('❌ Kinoni saqlashda xatolik yuz berdi!');
      logger.error('Error saving movie:', error);
    }
  }

  private async showAdminMenu(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const keyboard = new InlineKeyboard()
      .text("📹 Kino qo'shish", 'add_movie')
      .row()
      .text("🗑 Kino o'chirish", 'remove_movie')
      .row();

    if (this.isSuperAdmin(userId)) {
      keyboard.text("👤 Admin qo'shish", 'add_admin').row();
    }

    keyboard.text('❌ Admin rejimdan chiqish', 'exit_admin');

    await ctx.reply(
      '🔧 <b>Admin rejimi</b>\n\n' + 'Quyidagi tugmalardan birini tanlang:',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      },
    );
  }

  private async handleRegularUserMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;

    if (!msg.text) return;

    const text = msg.text.trim();

    if (!/^\d{1,4}$/.test(text)) {
      await ctx.reply("❌ Kino kodi 1-4 raqamdan iborat bo'lishi kerak!");
      return;
    }

    const movie = await this.databaseService.movie.findFirst({
      where: { code: text },
    });

    if (movie) {
      await this.sendMovie(ctx, movie);
    } else {
      await ctx.reply(
        '❌ Bu kod bilan kino topilmadi. Iltimos boshqa kod kiriting.',
      );
    }
  }

  private async isAdmin(userId: number): Promise<boolean> {
    if (this.isSuperAdmin(userId)) return true;

    const admin = await this.databaseService.admin.findFirst({
      where: { userId: userId.toString() },
    });

    return !!admin;
  }

  private isSuperAdmin(userId: number): boolean {
    return this.superAdminIds.includes(userId);
  }

  private getOrCreateSession(userId: number): AdminSession {
    if (!this.adminSessions.has(userId)) {
      this.adminSessions.set(userId, { isInAdminMode: false });
    }
    return this.adminSessions.get(userId)!;
  }

  private async createUserIfNotExist(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id;
    const username = ctx.from?.username;

    if (!telegramId) return;

    const user = await this.databaseService.user.findFirst({
      where: { telegramId: telegramId },
    });

    if (!user) {
      const newUser = await this.databaseService.user.create({
        data: { telegramId: telegramId, username: username },
      });
      logger.info(`User created: ${newUser}`);
    } else if (username && user.username !== username) {
      await this.databaseService.user.update({
        where: { telegramId: telegramId },
        data: { username: username },
      });
    }
  }

  private async showIntro(ctx: Context) {
    const firstName = ctx.from.first_name;
    const message =
      `👋 Assalomu alaykum, <b>${firstName}</b>! Botimizga xush kelibsiz!\n\n` +
      `📥 Davom etish uchun kino kodini yuboring.`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  }

  private async sendMovie(ctx: Context, movie: any): Promise<void> {
    try {
      await ctx.replyWithVideo(movie.fileId, {
        caption: `🎬 <b>${movie.title}</b>\n\n🤖 @kinolar_hub_bot`,
        parse_mode: 'HTML',
      });

      await this.databaseService.request.create({
        data: {
          userId: ctx.from?.id?.toString() || '',
          code: movie.code,
        },
      });

      logger.info(
        `Movie sent: ${movie.title} (${movie.code}) to user ${ctx.from?.id}`,
      );
    } catch (error) {
      await ctx.reply('❌ Kinoni yuborishda xatolik yuz berdi!');
      logger.error('Error sending movie:', error);
    }
  }

  registerBroadcastCommand(handler: (ctx: Context) => Promise<void>): void {
    this.bot.command('broadcast', handler);
  }
}
