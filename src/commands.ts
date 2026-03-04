import { Bot, Context, InlineKeyboard } from "grammy";
import { type Conversation, type ConversationFlavor, createConversation } from "@grammyjs/conversations";
import {
  createCollection,
  getActiveCollection,
  getCollectionStatus,
  updatePaymentStatus,
  closeCollection,
  getMemberByUsername,
  getMemberByUserId,
  getPayment,
} from "./db.js";

export type MyContext = Context & ConversationFlavor;
export type MyConversation = Conversation<MyContext, MyContext>;

// --- /newcollect conversation ---

async function newCollectConversation(conversation: MyConversation, ctx: MyContext) {
  const chatId = ctx.chat!.id;
  const adminId = ctx.from!.id;

  // Check if there's already an active collection
  const existing = getActiveCollection(chatId);
  if (existing) {
    await ctx.reply(`Уже есть активный сбор: "${existing.title}". Закройте его командой /close перед созданием нового.`);
    return;
  }

  await ctx.reply("Название сбора?");
  const titleMsg = await conversation.form.text({
    otherwise: (ctx) => ctx.reply("Пожалуйста, отправьте текст."),
  });

  await ctx.reply("Сумма с человека?");
  const amountMsg = await conversation.form.text({
    otherwise: (ctx) => ctx.reply("Пожалуйста, отправьте текст."),
  });

  await ctx.reply("Реквизиты для оплаты?");
  const detailsMsg = await conversation.form.text({
    otherwise: (ctx) => ctx.reply("Пожалуйста, отправьте текст."),
  });

  await ctx.reply('Дедлайн? (ДД.ММ.ГГГГ или "нет")');
  const deadlineRaw = await conversation.form.text({
    otherwise: (ctx) => ctx.reply("Пожалуйста, отправьте текст."),
  });

  let deadline: string | undefined;
  if (deadlineRaw !== "нет" && deadlineRaw !== "-") {
    // Parse DD.MM.YYYY to ISO
    const match = deadlineRaw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (match) {
      deadline = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    } else {
      // Try DD.MM (current year)
      const match2 = deadlineRaw.match(/^(\d{1,2})\.(\d{1,2})$/);
      if (match2) {
        const year = new Date().getFullYear();
        deadline = `${year}-${match2[2].padStart(2, "0")}-${match2[1].padStart(2, "0")}`;
      }
    }
  }

  const result = createCollection(chatId, adminId, titleMsg, amountMsg, detailsMsg, deadline);
  const collectionId = result.lastInsertRowid as number;

  const botInfo = await ctx.api.getMe();
  const keyboard = new InlineKeyboard().url(
    "Отправить скрин оплаты",
    `https://t.me/${botInfo.username}?start=pay_${collectionId}`,
  );

  const deadlineText = deadline ?? "не указан";
  await ctx.reply(
    `💰 Новый сбор: "${titleMsg}"\nСумма: ${amountMsg}\nРеквизиты: ${detailsMsg}\nДедлайн: ${deadlineText}\n\nНажмите кнопку ниже, чтобы отправить скрин оплаты:`,
    { reply_markup: keyboard },
  );
}

// --- Register all commands ---

export function registerCommands(bot: Bot<MyContext>) {
  bot.use(createConversation(newCollectConversation));

  bot.command("newcollect", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      return ctx.reply("Эта команда работает только в группах.");
    }
    await ctx.conversation.enter("newCollectConversation");
  });

  // --- /status ---
  bot.command("status", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      return ctx.reply("Эта команда работает только в группах.");
    }

    const collection = getActiveCollection(ctx.chat.id);
    if (!collection) {
      return ctx.reply("Нет активного сбора в этой группе.");
    }

    const { paid, unpaid } = getCollectionStatus(collection.id);
    const total = paid.length + unpaid.length;

    let text = `📊 Сбор "${collection.title}"\n`;
    text += `Сдали (${paid.length}/${total}):\n`;
    text += paid.length > 0
      ? paid.map((m) => `  ✅ ${m.first_name}`).join("\n")
      : "  —";
    text += `\nНе сдали (${unpaid.length}/${total}):\n`;
    text += unpaid.length > 0
      ? unpaid.map((m) => `  ❌ ${m.first_name}${m.username ? ` (@${m.username})` : ""}`).join("\n")
      : "  —";

    await ctx.reply(text);
  });

  // --- /confirm @user ---
  bot.command("confirm", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const collection = getActiveCollection(ctx.chat.id);
    if (!collection) return ctx.reply("Нет активного сбора.");
    if (ctx.from!.id !== collection.admin_id) return ctx.reply("Только админ сбора может подтверждать оплату.");

    const target = resolveTargetUser(ctx, collection.group_id);
    if (!target) return ctx.reply("Укажите пользователя: /confirm @username");

    const payment = getPayment(collection.id, target.user_id);
    if (!payment || payment.status === "confirmed") {
      return ctx.reply(`У ${target.first_name} нет ожидающего подтверждения платежа.`);
    }

    updatePaymentStatus(collection.id, target.user_id, "confirmed");
    await ctx.reply(`✅ Оплата от ${target.first_name} подтверждена!`);

    // Notify user in DM
    try {
      await ctx.api.sendMessage(target.user_id, `Ваша оплата для сбора "${collection.title}" подтверждена! ✅`);
    } catch { /* user may not have started bot */ }
  });

  // --- /reject @user reason ---
  bot.command("reject", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const collection = getActiveCollection(ctx.chat.id);
    if (!collection) return ctx.reply("Нет активного сбора.");
    if (ctx.from!.id !== collection.admin_id) return ctx.reply("Только админ сбора может отклонять оплату.");

    const args = (ctx.match ?? "").trim().split(/\s+/);
    const usernameRaw = args[0];
    const reason = args.slice(1).join(" ") || "Причина не указана";

    if (!usernameRaw) return ctx.reply("Укажите пользователя: /reject @username причина");

    const username = usernameRaw.replace(/^@/, "");
    const member = getMemberByUsername(username, collection.group_id);
    if (!member) return ctx.reply(`Пользователь @${username} не найден в группе.`);

    const payment = getPayment(collection.id, member.user_id);
    if (!payment || payment.status !== "pending") {
      return ctx.reply(`У ${member.first_name} нет ожидающего подтверждения платежа.`);
    }

    updatePaymentStatus(collection.id, member.user_id, "rejected", reason);
    await ctx.reply(`❌ Скрин от ${member.first_name} отклонён: ${reason}`);

    // Notify user in DM
    try {
      const botInfo = await ctx.api.getMe();
      const keyboard = new InlineKeyboard().url(
        "Отправить новый скрин",
        `https://t.me/${botInfo.username}?start=pay_${collection.id}`,
      );
      await ctx.api.sendMessage(
        member.user_id,
        `Ваш скриншот для сбора "${collection.title}" отклонён.\nПричина: ${reason}\n\nОтправьте новый скриншот:`,
        { reply_markup: keyboard },
      );
    } catch { /* user may not have started bot */ }
  });

  // --- /remind ---
  bot.command("remind", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const collection = getActiveCollection(ctx.chat.id);
    if (!collection) return ctx.reply("Нет активного сбора.");

    const { unpaid } = getCollectionStatus(collection.id);
    if (unpaid.length === 0) {
      return ctx.reply("Все участники уже сдали! 🎉");
    }

    const mentions = unpaid.map((m) => (m.username ? `@${m.username}` : m.first_name)).join(", ");
    await ctx.reply(
      `Ребята, ждём оплату от: ${mentions}\n\nСумма: ${collection.amount}\nРеквизиты: ${collection.details}`,
    );
  });

  // --- /close ---
  bot.command("close", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const collection = getActiveCollection(ctx.chat.id);
    if (!collection) return ctx.reply("Нет активного сбора.");
    if (ctx.from!.id !== collection.admin_id) return ctx.reply("Только админ сбора может закрыть его.");

    closeCollection(collection.id);
    const { paid, unpaid } = getCollectionStatus(collection.id);
    await ctx.reply(
      `Сбор "${collection.title}" закрыт.\nСдали: ${paid.length}, не сдали: ${unpaid.length}.`,
    );
  });
}

// Helper: resolve target user from @username in command args or reply
function resolveTargetUser(ctx: Context, groupId: number) {
  // Try reply
  if (ctx.message?.reply_to_message?.from) {
    const userId = ctx.message.reply_to_message.from.id;
    return getMemberByUserId(userId, groupId);
  }

  // Try @username from args
  const args = (ctx.match as string ?? "").trim();
  if (!args) return undefined;

  const username = args.split(/\s+/)[0].replace(/^@/, "");
  return getMemberByUsername(username, groupId);
}
