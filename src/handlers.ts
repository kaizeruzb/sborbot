import { Bot, Context } from "grammy";
import { ConversationFlavor } from "@grammyjs/conversations";
import { upsertMember, deactivateMember, getCollectionById, addPayment, getPayment } from "./db.js";

type MyContext = Context & ConversationFlavor<Context>;

// In-memory state: userId -> collectionId they're about to send a screenshot for
const pendingScreenshots = new Map<number, number>();

export { pendingScreenshots };

export function registerHandlers(bot: Bot<MyContext>) {
  // Track members via chat_member events
  bot.on("chat_member", (ctx) => {
    const member = ctx.chatMember.new_chat_member;
    const groupId = ctx.chat.id;

    if (member.status === "member" || member.status === "administrator" || member.status === "creator") {
      upsertMember(member.user.id, groupId, member.user.first_name, member.user.username);
    } else if (member.status === "left" || member.status === "kicked") {
      deactivateMember(member.user.id, groupId);
    }
  });

  // Fallback: track members by messages in group
  bot.on("message", (ctx, next) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      upsertMember(ctx.from!.id, ctx.chat.id, ctx.from!.first_name, ctx.from!.username);
    }
    return next();
  });

  // Handle /start with deep link for payment
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const payload = ctx.match;
    if (payload?.startsWith("pay_")) {
      const collectionId = parseInt(payload.slice(4));
      const collection = getCollectionById(collectionId);

      if (!collection || collection.status !== "active") {
        return ctx.reply("Этот сбор уже закрыт или не существует.");
      }

      const existing = getPayment(collectionId, ctx.from!.id);
      if (existing && existing.status === "confirmed") {
        return ctx.reply("Ваша оплата уже подтверждена!");
      }
      if (existing && existing.status === "pending") {
        return ctx.reply("Ваш скриншот уже отправлен и ожидает подтверждения от админа.");
      }

      // If rejected — allow re-upload
      pendingScreenshots.set(ctx.from!.id, collectionId);
      await ctx.reply(
        `Отправьте скриншот оплаты для сбора "${collection.title}"\n\nСумма: ${collection.amount}\nРеквизиты: ${collection.details}`,
      );
      return;
    }

    await ctx.reply("Привет! Добавьте меня в группу и используйте /newcollect для создания сбора.");
  });

  // Handle photo in DM — accept screenshot
  bot.on("message:photo", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const collectionId = pendingScreenshots.get(ctx.from!.id);
    if (!collectionId) return;

    const collection = getCollectionById(collectionId);
    if (!collection || collection.status !== "active") {
      pendingScreenshots.delete(ctx.from!.id);
      return ctx.reply("Этот сбор уже закрыт.");
    }

    const fileId = ctx.message!.photo![ctx.message!.photo!.length - 1].file_id;
    addPayment(collectionId, ctx.from!.id, fileId);
    pendingScreenshots.delete(ctx.from!.id);

    await ctx.reply("Скриншот получен! Ожидайте подтверждения от админа.");

    // Notify admin
    try {
      const name = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name;
      await ctx.api.sendPhoto(collection.admin_id, fileId, {
        caption: `Новый скрин оплаты от ${name} для сбора "${collection.title}"`,
      });
    } catch {
      // Admin may not have started the bot — ignore
    }
  });
}
