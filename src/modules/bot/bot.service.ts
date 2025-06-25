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
  awaitingChannelInfo?: boolean;
  awaitingChannelRemoval?: boolean;
  awaitingMovieRemoval?: boolean; // Added this flag
}

@Injectable()
export class BotService implements OnModuleInit {
  private readonly bot: Bot<Context>;
  private readonly sourceChannelIdUZ: string = process.env.CHANNEL_UZ_ID;
  private readonly superAdminIds: number[] = [ADMIN_ID_REDACTED, ADMIN_ID_REDACTED];
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

  registerBroadcastCommand(handler: (ctx: Context) => Promise<void>): void {
    this.bot.command('broadcast', handler);
  }

  private setupHandlers(): void {
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('admin', this.handleAdminCommand.bind(this));
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    this.bot.on('message', this.handleMessage.bind(this));
  }

  private async handleStart(ctx: Context): Promise<void> {
    await this.createUserIfNotExist(ctx);
    const isSubscribed = await this.checkChannelSubscriptions(ctx);
    await this.showIntro(ctx);
    if (!isSubscribed) return;
  }

  private async safeReply(
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      if (ctx.callbackQuery) {
        try {
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (err: any) {
          if (
            err.error_code === 400 &&
            err.description?.includes("message can't be edited")
          ) {
            await ctx.reply(text, {
              parse_mode: 'HTML',
              reply_markup: keyboard,
            });
          } else {
            throw err;
          }
        }
      } else {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }
    } catch (error) {
      logger.error('Error in safeReply:', error);
      await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
    }
  }

  private async handleAdminCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !(await this.isAdmin(userId))) {
      // await ctx.reply('❌ Bu buyruq faqat adminlar uchun!');
      return;
    }

    const session = this.getOrCreateSession(userId);
    session.isInAdminMode = true;
    // Reset all waiting states when entering admin mode
    this.resetSessionStates(session);
    await this.showMainAdminMenu(ctx);
  }

  private resetSessionStates(session: AdminSession): void {
    session.awaitingMovieCode = false;
    session.awaitingNewAdminId = false;
    session.awaitingChannelInfo = false;
    session.awaitingChannelRemoval = false;
    session.awaitingMovieRemoval = false;
    session.pendingMovie = undefined;
  }

  private async showMainAdminMenu(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const keyboard = new InlineKeyboard()
      .text('🎬 Kino boshqaruvi', 'movie_management')
      .row()
      .text('📺 Kanal boshqaruvi', 'channel_management')
      .row();

    if (this.isSuperAdmin(userId)) {
      keyboard.text('👥 Admin boshqaruvi', 'admin_management').row();
    }

    keyboard.text('❌ Admin rejimdan chiqish', 'exit_admin');

    await this.safeReply(
      ctx,
      "🔧 <b>Admin rejimi faollashtirildi!</b>\n\nBoshqarish bo'limini tanlang:",
      keyboard,
    );
  }

  private getMenuKeyboard(type: string): InlineKeyboard {
    const keyboards = {
      movie: new InlineKeyboard()
        .text("➕ Kino qo'shish", 'add_movie')
        .row()
        .text("➖ Kino o'chirish", 'remove_movie')
        .row()
        .text("📋 Kinolar ro'yxati", 'list_movies')
        .row()
        .text('⬅️ Orqaga', 'back_to_main'),

      channel: new InlineKeyboard()
        .text("➕ Kanal qo'shish", 'add_channel')
        .row()
        .text("➖ Kanal o'chirish", 'remove_channel')
        .row()
        .text("📋 Kanallar ro'yxati", 'list_channels')
        .row()
        .text('⬅️ Orqaga', 'back_to_main'),

      admin: new InlineKeyboard()
        .text("➕ Admin qo'shish", 'add_admin')
        .row()
        .text("📋 Adminlar ro'yxati", 'list_admins')
        .row()
        .text('⬅️ Orqaga', 'back_to_main'),
    };

    return keyboards[type];
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery?.data;
    const userId = ctx.from?.id;

    if (!userId || !callbackData) return;

    await ctx.answerCallbackQuery();
    const session = this.getOrCreateSession(userId);

    const actions = {
      movie_management: () => {
        this.resetSessionStates(session);
        return this.safeReply(
          ctx,
          '🎬 <b>Kino boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('movie'),
        );
      },
      channel_management: () => {
        this.resetSessionStates(session);
        return this.safeReply(
          ctx,
          '📺 <b>Kanal boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('channel'),
        );
      },
      admin_management: () => {
        if (!this.isSuperAdmin(userId)) return null;
        this.resetSessionStates(session);
        return this.safeReply(
          ctx,
          '👥 <b>Admin boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('admin'),
        );
      },
      back_to_main: () => {
        this.resetSessionStates(session);
        return this.showMainAdminMenu(ctx);
      },
      add_movie: () => {
        this.resetSessionStates(session);
        return this.safeReply(
          ctx,
          "📹 <b>Kino qo'shish</b>\n\nIltimos kanaldan kinoni forward qiling yoki video/hujjat yuboring:",
          this.getBackKeyboard('movie_management'),
        );
      },
      remove_movie: () => {
        this.resetSessionStates(session);
        session.awaitingMovieRemoval = true;
        return this.safeReply(
          ctx,
          "🗑 <b>Kino o'chirish</b>\n\nO'chirmoqchi bo'lgan kino kodini yuboring:",
          this.getBackKeyboard('movie_management'),
        );
      },
      list_movies: () => this.handleListMovies(ctx),
      add_channel: () => this.handleAddChannelCallback(ctx, session),
      remove_channel: () => this.handleRemoveChannelCallback(ctx, session),
      list_channels: () => this.handleListChannels(ctx),
      add_admin: () =>
        this.isSuperAdmin(userId)
          ? this.handleAddAdminCallback(ctx, session)
          : null,
      list_admins: () =>
        this.isSuperAdmin(userId) ? this.handleListAdmins(ctx) : null,
      exit_admin: () => this.handleExitAdminCallback(ctx, userId),
      check_subscription: () => this.handleCheckSubscription(ctx),
    };

    const action = actions[callbackData];
    if (action) {
      await action();
    }
  }

  private getBackKeyboard(backTo: string): InlineKeyboard {
    return new InlineKeyboard().text('⬅️ Orqaga', backTo);
  }

  private async handleListMovies(ctx: Context): Promise<void> {
    const movies = await this.databaseService.movie.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { admin: true },
    });

    if (movies.length === 0) {
      await this.safeReply(
        ctx,
        "📋 Hozircha kinolar yo'q!",
        this.getBackKeyboard('movie_management'),
      );
      return;
    }

    const moviesList =
      '📋 <b>Oxirgi 10 ta kino:</b>\n\n' +
      movies
        .map(
          (movie, index) =>
            `${index + 1}. <b>${movie.title}</b>\n   📟 Kod: <code>${movie.code}</code>\n   📅 Qo'shilgan: ${movie.createdAt.toLocaleDateString()}\n`,
        )
        .join('\n');

    const keyboard = new InlineKeyboard().text('⬅️ Orqaga', 'movie_management');
    await this.safeReply(ctx, moviesList, keyboard);
  }

  private async handleAddChannelCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    this.resetSessionStates(session);
    session.awaitingChannelInfo = true;
    await this.safeReply(
      ctx,
      "📺 <b>Kanal qo'shish</b>\n\nKanal username'ini @ belgisisiz yuboring:\nMasalan: <code>mychannel</code>",
      this.getBackKeyboard('channel_management'),
    );
  }

  private async handleRemoveChannelCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    this.resetSessionStates(session);
    session.awaitingChannelRemoval = true;
    await this.safeReply(
      ctx,
      "🗑 <b>Kanal o'chirish</b>\n\nO'chirmoqchi bo'lgan kanal username'ini yuboring:",
      this.getBackKeyboard('channel_management'),
    );
  }

  private async handleListChannels(ctx: Context): Promise<void> {
    const channels = await this.databaseService.requiredChannel.findMany({
      where: { enabled: 1 },
    });

    if (channels.length === 0) {
      await this.safeReply(
        ctx,
        "📋 Hozircha majburiy kanallar yo'q!",
        this.getBackKeyboard('channel_management'),
      );
      return;
    }

    const channelsList =
      '📋 <b>Majburiy kanallar:</b>\n\n' +
      channels
        .map(
          (channel, index) =>
            `${index + 1}. @${channel.username}\n   🆔 ID: <code>${channel.channelId}</code>\n`,
        )
        .join('\n');

    const keyboard = new InlineKeyboard().text(
      '⬅️ Orqaga',
      'channel_management',
    );
    await this.safeReply(ctx, channelsList, keyboard);
  }

  private async handleAddAdminCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    this.resetSessionStates(session);
    session.awaitingNewAdminId = true;
    await this.safeReply(
      ctx,
      "👤 <b>Admin qo'shish</b>\n\nYangi admin bo'lishi kerak bo'lgan foydalanuvchi ID sini yuboring:",
      this.getBackKeyboard('admin_management'),
    );
  }

  private async handleListAdmins(ctx: Context): Promise<void> {
    const admins = await this.databaseService.admin.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    let adminsList =
      "👥 <b>Adminlar ro'yxati:</b>\n\n🔱 <b>Super Adminlar:</b>\n" +
      this.superAdminIds
        .map((id, index) => `${index + 1}. ID: <code>${id}</code>`)
        .join('\n') +
      '\n\n';

    if (admins.length > 0) {
      adminsList +=
        '👤 <b>Oddiy Adminlar:</b>\n' +
        admins
          .map(
            (admin, index) =>
              `${index + 1}. ID: <code>${admin.userId}</code>\n   📅 Qo'shilgan: ${admin.createdAt.toLocaleDateString()}\n`,
          )
          .join('\n');
    }

    const keyboard = new InlineKeyboard().text('⬅️ Orqaga', 'admin_management');
    await this.safeReply(ctx, adminsList, keyboard);
  }

  private async handleExitAdminCallback(
    ctx: Context,
    userId: number,
  ): Promise<void> {
    this.adminSessions.delete(userId);
    await this.safeReply(ctx, '❌ Admin rejimdan chiqdingiz!');
  }

  private async handleCheckSubscription(ctx: Context): Promise<void> {
    const isSubscribed = await this.checkChannelSubscriptions(ctx);
    if (isSubscribed) {
      await this.safeReply(
        ctx,
        "✅ Barcha kanallarga obuna bo'ldingiz! Endi kino kodini yuboring.",
      );
    }
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = this.adminSessions.get(userId);

    if (session?.isInAdminMode) {
      await this.handleAdminMessage(ctx, session);
    } else {
      await this.handleRegularUserMessage(ctx);
    }
  }

  private async handleAdminMessage(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    const msg = ctx.message;

    if (session.awaitingNewAdminId && msg.text) {
      await this.processNewAdminId(ctx, msg.text, session);
      return;
    }

    if (session.awaitingChannelInfo && msg.text) {
      await this.processNewChannel(ctx, msg.text, session);
      return;
    }

    if (session.awaitingChannelRemoval && msg.text) {
      await this.processChannelRemoval(ctx, msg.text, session);
      return;
    }

    if (session.awaitingMovieCode && msg.text) {
      await this.processMovieCode(ctx, msg.text, session);
      return;
    }

    // Only process movie removal if explicitly waiting for it
    if (
      session.awaitingMovieRemoval &&
      msg.text &&
      /^\d{1,4}$/.test(msg.text.trim())
    ) {
      await this.processMovieRemoval(ctx, msg.text.trim(), session);
      return;
    }

    const forwardedFromChannelId = (msg as any).forward_from_chat?.id;
    if (
      forwardedFromChannelId == this.sourceChannelIdUZ ||
      msg.video ||
      msg.document
    ) {
      await this.processMovieUpload(ctx, session);
      return;
    }

    await ctx.reply(
      "❌ Noto'g'ri format! Admin rejimdan chiqish uchun /admin buyrug'ini ishlating.",
    );
  }

  private async processNewChannel(
    ctx: Context,
    username: string,
    session: AdminSession,
  ): Promise<void> {
    const cleanUsername = username.replace('@', '').trim();

    if (!cleanUsername) {
      await ctx.reply("❌ Kanal username'i bo'sh bo'lishi mumkin emas!");
      return;
    }

    try {
      const chat = await this.bot.api.getChat(`@${cleanUsername}`);

      if (chat.type !== 'channel') {
        await ctx.reply('❌ Bu kanal emas!');
        return;
      }

      const existingChannel =
        await this.databaseService.requiredChannel.findFirst({
          where: { username: cleanUsername },
        });

      if (existingChannel) {
        await ctx.reply("❌ Bu kanal allaqachon qo'shilgan!");
        return;
      }

      await this.databaseService.requiredChannel.create({
        data: {
          channelId: chat.id.toString(),
          username: cleanUsername,
          enabled: 1,
        },
      });

      session.awaitingChannelInfo = false;

      await ctx.reply(
        `✅ Kanal muvaffaqiyatli qo'shildi!\n\n📺 Kanal: @${cleanUsername}\n🆔 ID: <code>${chat.id}</code>`,
        { parse_mode: 'HTML' },
      );

      setTimeout(
        () =>
          this.safeReply(
            ctx,
            '📺 <b>Kanal boshqaruvi</b>\n\nKerakli amalni tanlang:',
            this.getMenuKeyboard('channel'),
          ),
        1000,
      );
    } catch (error) {
      await ctx.reply("❌ Kanal topilmadi yoki botda ruxsat yo'q!");
      logger.error('Error adding channel:', error);
    }
  }

  private async processChannelRemoval(
    ctx: Context,
    username: string,
    session: AdminSession,
  ): Promise<void> {
    const cleanUsername = username.replace('@', '').trim();

    const channel = await this.databaseService.requiredChannel.findFirst({
      where: { username: cleanUsername },
    });

    if (!channel) {
      await ctx.reply(`❌ @${cleanUsername} kanali topilmadi!`);
      return;
    }

    await this.databaseService.requiredChannel.delete({
      where: { id: channel.id },
    });

    session.awaitingChannelRemoval = false;

    await ctx.reply(
      `✅ Kanal muvaffaqiyatli o'chirildi!\n\n📺 Kanal: @${cleanUsername}`,
      { parse_mode: 'HTML' },
    );

    setTimeout(
      () =>
        this.safeReply(
          ctx,
          '📺 <b>Kanal boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('channel'),
        ),
      1000,
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

    const existingAdmin = await this.databaseService.admin.findFirst({
      where: { userId: newAdminId.toString() },
    });

    if (existingAdmin) {
      await ctx.reply('❌ Bu foydalanuvchi allaqachon admin!');
      return;
    }

    await this.databaseService.admin.create({
      data: { userId: newAdminId.toString() },
    });

    session.awaitingNewAdminId = false;

    await ctx.reply(
      `✅ Yangi admin muvaffaqiyatli qo'shildi!\n\n👤 Admin ID: <code>${newAdminId}</code>`,
      { parse_mode: 'HTML' },
    );

    setTimeout(
      () =>
        this.safeReply(
          ctx,
          '👥 <b>Admin boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('admin'),
        ),
      1000,
    );
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

    const existingMovie = await this.databaseService.movie.findFirst({
      where: { code: code },
    });

    if (existingMovie) {
      await ctx.reply(
        `❌ ${code} kodi allaqachon ishlatilgan! Boshqa kod kiriting.`,
      );
      return;
    }

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

    title = msg.caption?.split('\n')[0] || 'Unknown Movie';

    session.pendingMovie = {
      fileId: fileId,
      title: title,
      userId: ctx.from?.id,
      timestamp: Date.now(),
    };
    session.awaitingMovieCode = true;

    await ctx.reply(
      `🎬 Kino: <b>${title}</b>\n\n📝 Iltimos bu kino uchun 1-4 raqamli kod yuboring:`,
      { parse_mode: 'HTML' },
    );
  }

  private async processMovieRemoval(
    ctx: Context,
    code: string,
    session: AdminSession,
  ): Promise<void> {
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

    session.awaitingMovieRemoval = false;

    await ctx.reply(
      `✅ Kino muvaffaqiyatli o'chirildi!\n\n🎬 Nomi: <b>${movie.title}</b>\n🔢 Kod: <b>${code}</b>`,
      { parse_mode: 'HTML' },
    );

    setTimeout(
      () =>
        this.safeReply(
          ctx,
          '🎬 <b>Kino boshqaruvi</b>\n\nKerakli amalni tanlang:',
          this.getMenuKeyboard('movie'),
        ),
      1000,
    );
  }

  private async saveMovie(
    ctx: Context,
    pendingMovie: PendingMovie,
    code: string,
    session: AdminSession,
  ): Promise<void> {
    try {
      const userId = ctx.from?.id;

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
        `✅ Kino muvaffaqiyatli saqlandi!\n\n🎬 Nomi: <b>${pendingMovie.title}</b>\n🔢 Kod: <b>${code}</b>`,
        { parse_mode: 'HTML' },
      );

      logger.info(`Movie saved: ${movie.title} with code ${movie.code}`);

      setTimeout(
        () =>
          this.safeReply(
            ctx,
            '🎬 <b>Kino boshqaruvi</b>\n\nKerakli amalni tanlang:',
            this.getMenuKeyboard('movie'),
          ),
        1000,
      );
    } catch (error) {
      await ctx.reply('❌ Kinoni saqlashda xatolik yuz berdi!');
      logger.error('Error saving movie:', error);
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
      logger.info(`User created: ${newUser.id}`);
    } else if (username && user.username !== username) {
      await this.databaseService.user.update({
        where: { telegramId: telegramId },
        data: { username: username },
      });
    }
  }

  private async showIntro(ctx: Context) {
    const firstName = ctx.from.first_name;
    const message = `👋 Assalomu alaykum, <b>${firstName}</b>! Botimizga xush kelibsiz!\n\n📥 Davom etish uchun kino kodini yuboring.`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  }

  private async sendMovie(ctx: Context, movie: any): Promise<void> {
    try {
      await ctx.replyWithVideo(movie.fileId, {
        caption: `🎬 <b>${movie.title}</b>\n\n🤖 @kinolar_hub_bot`,
        parse_mode: 'HTML',
        protect_content: true,
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

  private async handleRegularUserMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;

    if (!msg.text) return;

    const text = msg.text.trim();

    const isSubscribed = await this.checkChannelSubscriptions(ctx);
    if (!isSubscribed) return;

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

  private async checkChannelSubscriptions(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    const requiredChannels =
      await this.databaseService.requiredChannel.findMany({
        where: { enabled: 1 },
      });

    if (requiredChannels.length === 0) return true;

    const unsubscribedChannels = [];

    for (const channel of requiredChannels) {
      try {
        const member = await this.bot.api.getChatMember(
          channel.channelId,
          userId,
        );

        // Check if user is NOT subscribed (only left or kicked are truly unsubscribed)
        if (member.status === 'left' || member.status === 'kicked') {
          unsubscribedChannels.push(channel);
        }
        // All other statuses (creator, administrator, member, restricted) are considered subscribed
      } catch (error) {
        logger.error(
          `Error checking membership for channel ${channel.username}:`,
          error,
        );

        // More specific error handling
        if (
          error.error_code === 400 &&
          error.description?.includes('chat not found')
        ) {
          logger.error(
            `Channel ${channel.username} not found - may need to be removed from database`,
          );
          // Still treat as unsubscribed to prevent access
          unsubscribedChannels.push(channel);
        } else if (
          error.error_code === 400 &&
          error.description?.includes('user not found')
        ) {
          // User might have privacy settings - treat as unsubscribed for safety
          unsubscribedChannels.push(channel);
        } else {
          // For other errors (network, rate limit, etc.), give user benefit of doubt
          // or implement retry logic
          logger.warn(
            `API error checking subscription for ${channel.username}, skipping check`,
          );
          // Optionally: unsubscribedChannels.push(channel); for stricter checking
        }
      }
    }

    if (unsubscribedChannels.length > 0) {
      await this.showChannelSubscriptionMessage(ctx, unsubscribedChannels);
      return false;
    }

    return true;
  }

  private async showChannelSubscriptionMessage(
    ctx: Context,
    channels: any[],
  ): Promise<void> {
    const keyboard = new InlineKeyboard();

    channels.forEach((channel, index) => {
      keyboard
        .url(`${index + 1} - kanal`, `https://t.me/${channel.username}`)
        .row();
    });

    keyboard.text('✅ Tasdiqlash', 'check_subscription');

    const message =
      "❌ Kechirasiz botimizdan foydalanishdan oldin ushbu kanallarga a'zo bo'lishingiz kerak.\n\nQuyidagi kanallarga a'zo bo'ling:";

    await ctx.reply(message, { reply_markup: keyboard });
  }
}
