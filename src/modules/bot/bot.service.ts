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
}

@Injectable()
export class BotService implements OnModuleInit {
  private readonly bot: Bot<Context>;
  private readonly sourceChannelIdUZ: string = process.env.CHANNEL_UZ_ID;
  private readonly superAdminIds: number[] = [ADMIN_ID_REDACTED, ADMIN_ID_REDACTED]; // Super admins
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

    const isSubscribed = await this.checkChannelSubscriptions(ctx);

    await this.showIntro(ctx);

    if (!isSubscribed) return;
  }

  private async safeEditOrReply(
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
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
  }

  private async handleAdminCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !(await this.isAdmin(userId))) {
      await ctx.reply('❌ Bu buyruq faqat adminlar uchun!');
      return;
    }

    const session = this.getOrCreateSession(userId);
    session.isInAdminMode = true;

    await this.showMainAdminMenu(ctx);
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

    const messageText =
      "🔧 <b>Admin rejimi faollashtirildi!</b>\n\nBoshqarish bo'limini tanlang:";

    await this.safeEditOrReply(ctx, messageText, keyboard);
  }

  private async showMovieManagement(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("➕ Kino qo'shish", 'add_movie')
      .row()
      .text("➖ Kino o'chirish", 'remove_movie')
      .row()
      .text("📋 Kinolar ro'yxati", 'list_movies')
      .row()
      .text('⬅️ Orqaga', 'back_to_main');

    await ctx.editMessageText(
      '🎬 <b>Kino boshqaruvi</b>\n\n' + 'Kerakli amalni tanlang:',
      {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      },
    );
  }

  private async showChannelManagement(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("➕ Kanal qo'shish", 'add_channel')
      .row()
      .text("➖ Kanal o'chirish", 'remove_channel')
      .row()
      .text("📋 Kanallar ro'yxati", 'list_channels')
      .row()
      .text('⬅️ Orqaga', 'back_to_main');

    const text = '📺 <b>Kanal boshqaruvi</b>\n\nKerakli amalni tanlang:';

    await this.safeEditOrReply(ctx, text, keyboard);
  }

  private async showAdminManagement(ctx: Context): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("➕ Admin qo'shish", 'add_admin')
      .row()
      .text("📋 Adminlar ro'yxati", 'list_admins')
      .row()
      .text('⬅️ Orqaga', 'back_to_main');

    await ctx.editMessageText(
      '👥 <b>Admin boshqaruvi</b>\n\n' + 'Kerakli amalni tanlang:',
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
      // Main menu navigation
      case 'movie_management':
        await this.showMovieManagement(ctx);
        break;
      case 'channel_management':
        await this.showChannelManagement(ctx);
        break;
      case 'admin_management':
        if (this.isSuperAdmin(userId)) {
          await this.showAdminManagement(ctx);
        }
        break;
      case 'back_to_main':
        await this.showMainAdminMenu(ctx);
        break;

      // Movie actions
      case 'add_movie':
        await this.handleAddMovieCallback(ctx, session);
        break;
      case 'remove_movie':
        await this.handleRemoveMovieCallback(ctx);
        break;
      case 'list_movies':
        await this.handleListMovies(ctx);
        break;

      // Channel actions
      case 'add_channel':
        await this.handleAddChannelCallback(ctx, session);
        break;
      case 'remove_channel':
        await this.handleRemoveChannelCallback(ctx, session);
        break;
      case 'list_channels':
        await this.handleListChannels(ctx);
        break;

      // Admin actions
      case 'add_admin':
        if (this.isSuperAdmin(userId)) {
          await this.handleAddAdminCallback(ctx, session);
        }
        break;
      case 'list_admins':
        if (this.isSuperAdmin(userId)) {
          await this.handleListAdmins(ctx);
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

  private async handleListMovies(ctx: Context): Promise<void> {
    const movies = await this.databaseService.movie.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { admin: true },
    });

    if (movies.length === 0) {
      await ctx.editMessageText("📋 Hozircha kinolar yo'q!");
      return;
    }

    let moviesList = '📋 <b>Oxirgi 10 ta kino:</b>\n\n';
    movies.forEach((movie, index) => {
      moviesList += `${index + 1}. <b>${movie.title}</b>\n`;
      moviesList += `   📟 Kod: <code>${movie.code}</code>\n`;
      moviesList += `   📅 Qo'shilgan: ${movie.createdAt.toLocaleDateString()}\n\n`;
    });

    const keyboard = new InlineKeyboard().text('⬅️ Orqaga', 'movie_management');

    await ctx.editMessageText(moviesList, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  private async handleAddChannelCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    session.awaitingChannelInfo = true;
    await ctx.editMessageText(
      "📺 <b>Kanal qo'shish</b>\n\n" +
        "Kanal username'ini @ belgisisiz yuboring:\n" +
        'Masalan: <code>mychannel</code>',
      { parse_mode: 'HTML' },
    );
  }

  private async handleRemoveChannelCallback(
    ctx: Context,
    session: AdminSession,
  ): Promise<void> {
    session.awaitingChannelRemoval = true;
    await ctx.editMessageText(
      "🗑 <b>Kanal o'chirish</b>\n\n" +
        "O'chirmoqchi bo'lgan kanal username'ini yuboring:",
      { parse_mode: 'HTML' },
    );
  }

  private async handleListChannels(ctx: Context): Promise<void> {
    const channels = await this.databaseService.requiredChannel.findMany({
      where: { enabled: 1 },
    });

    if (channels.length === 0) {
      await ctx.editMessageText("📋 Hozircha majburiy kanallar yo'q!");
      return;
    }

    let channelsList = '📋 <b>Majburiy kanallar:</b>\n\n';
    channels.forEach((channel, index) => {
      channelsList += `${index + 1}. @${channel.username}\n`;
      channelsList += `   🆔 ID: <code>${channel.channelId}</code>\n\n`;
    });

    const keyboard = new InlineKeyboard().text(
      '⬅️ Orqaga',
      'channel_management',
    );

    await ctx.editMessageText(channelsList, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
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

  private async handleListAdmins(ctx: Context): Promise<void> {
    const admins = await this.databaseService.admin.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    let adminsList = "👥 <b>Adminlar ro'yxati:</b>\n\n";

    // Add super admins
    adminsList += '🔱 <b>Super Adminlar:</b>\n';
    this.superAdminIds.forEach((id, index) => {
      adminsList += `${index + 1}. ID: <code>${id}</code>\n`;
    });
    adminsList += '\n';

    // Add regular admins
    if (admins.length > 0) {
      adminsList += '👤 <b>Oddiy Adminlar:</b>\n';
      admins.forEach((admin, index) => {
        adminsList += `${index + 1}. ID: <code>${admin.userId}</code>\n`;
        adminsList += `   📅 Qo'shilgan: ${admin.createdAt.toLocaleDateString()}\n\n`;
      });
    }

    const keyboard = new InlineKeyboard().text('⬅️ Orqaga', 'admin_management');

    await ctx.editMessageText(adminsList, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
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

    // Handle channel info input
    if (session.awaitingChannelInfo && msg.text) {
      await this.processNewChannel(ctx, msg.text, session);
      return;
    }

    // Handle channel removal input
    if (session.awaitingChannelRemoval && msg.text) {
      await this.processChannelRemoval(ctx, msg.text, session);
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
      // Try to get channel info
      const chat = await this.bot.api.getChat(`@${cleanUsername}`);

      if (chat.type !== 'channel') {
        await ctx.reply('❌ Bu kanal emas!');
        return;
      }

      // Check if channel already exists
      const existingChannel =
        await this.databaseService.requiredChannel.findFirst({
          where: { username: cleanUsername },
        });

      if (existingChannel) {
        await ctx.reply("❌ Bu kanal allaqachon qo'shilgan!");
        return;
      }

      // Add channel
      await this.databaseService.requiredChannel.create({
        data: {
          channelId: chat.id.toString(),
          username: cleanUsername,
          enabled: 1,
        },
      });

      session.awaitingChannelInfo = false;

      await ctx.reply(
        `✅ Kanal muvaffaqiyatli qo'shildi!\n\n` +
          `📺 Kanal: @${cleanUsername}\n` +
          `🆔 ID: <code>${chat.id}</code>`,
        { parse_mode: 'HTML' },
      );

      // Show channel management menu
      await this.showChannelManagement(ctx);
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
      `✅ Kanal muvaffaqiyatli o'chirildi!\n\n` + `📺 Kanal: @${cleanUsername}`,
      { parse_mode: 'HTML' },
    );

    // Show channel management menu
    await this.showChannelManagement(ctx);
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

    // Show admin management menu
    await this.showAdminManagement(ctx);
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

    await this.showMovieManagement(ctx);
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

      // Show movie management menu
      await this.showMovieManagement(ctx);
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

  private async handleRegularUserMessage(ctx: Context): Promise<void> {
    const msg = ctx.message;

    if (!msg.text) return;

    const text = msg.text.trim();

    // Check subscriptions first
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

  registerBroadcastCommand(handler: (ctx: Context) => Promise<void>): void {
    this.bot.command('broadcast', handler);
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
        if (member.status === 'left' || member.status === 'kicked') {
          unsubscribedChannels.push(channel);
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        // If we can't check membership, assume user is not subscribed
        unsubscribedChannels.push(channel);
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

    // Add channel buttons
    channels.forEach((channel, index) => {
      keyboard
        .url(`${index + 1} - kanal`, `https://t.me/@${channel.username}`)
        .row();
    });

    // Add confirmation button
    keyboard.text('✅ Tasdiqlash', 'check_subscription');

    const message =
      "❌ Kechirasiz botimizdan foydalanishdan oldin ushbu kanallarga a'zo bo'lishingiz kerak.\n\n" +
      "Quyidagi kanallarga a'zo bo'ling:";

    await ctx.reply(message, {
      reply_markup: keyboard,
    });
  }
}
