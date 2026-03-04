import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import {
  handleNewCollect, handleStatus, handleRemind,
  handleClose, handleCancel, handleHistory, handlePaid, formatMoney, buildStatusText,
} from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { getActiveCollectionsWithDeadline, getActiveCollections, getCollectionStatus, closeCollection } from "./db.js";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment");
}

const bot = new Bot(process.env.BOT_TOKEN);

bot.catch((err) => {
  console.error("Bot error:", err.message ?? err);
});

// Event handlers (member tracking, /start, photos, callbacks, admin DM text)
registerHandlers(bot);

// Admin commands (DM only, except /status which also works in groups)
bot.command("newcollect", handleNewCollect);
bot.command("status", handleStatus);
bot.command("remind", handleRemind);
bot.command("close", handleClose);
bot.command("cancel", handleCancel);
bot.command("history", handleHistory);
bot.command("paid", handlePaid);

// --- Hourly: deadline checks + auto-status in groups ---

async function hourlyTick() {
  const now = new Date();

  // Check deadlines
  const withDeadline = getActiveCollectionsWithDeadline();
  for (const collection of withDeadline) {
    const deadline = new Date(collection.deadline! + "T23:59:59");
    const hoursLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursLeft < 0) {
      closeCollection(collection.id);
      const { paid, pending, knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collection.id);
      bot.api.sendMessage(collection.group_id,
        `⏰ Дедлайн сбора "${collection.title}" прошёл. Сбор закрыт.\n✅ ${paid.length} | ⏳ ${pending.length} | ❌ ~${knownUnpaid.length + unknownUnpaidCount}`,
      ).catch(() => {});
    } else if (hoursLeft <= 24) {
      const { knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collection.id);
      if (knownUnpaid.length + unknownUnpaidCount > 0) {
        const mentions = knownUnpaid.map((m) => (m.username ? `@${m.username}` : m.first_name)).join(", ");
        bot.api.sendMessage(collection.group_id,
          `⏰ До дедлайна сбора "${collection.title}" меньше суток!\n\nЖдём: ${mentions}\nСумма: ${formatMoney(collection.per_person)}\nРеквизиты: ${collection.details}`,
        ).catch(() => {});
      }
    }
  }

  // Auto-status for all active collections
  const allActive = getActiveCollections();
  for (const collection of allActive) {
    const { paid, pending, knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collection.id);
    const totalUnpaid = knownUnpaid.length + unknownUnpaidCount;
    // Only send if there are still unpaid people
    if (totalUnpaid > 0 || pending.length > 0) {
      const botInfo = await bot.api.getMe();
      const kb = new InlineKeyboard().url(
        "💳 Отправить скрин оплаты",
        `https://t.me/${botInfo.username}?start=pay_${collection.id}`,
      );
      bot.api.sendMessage(collection.group_id, buildStatusText(collection), { reply_markup: kb }).catch(() => {});
    }
  }
}

setInterval(hourlyTick, 60 * 60 * 1000);

bot.start({
  allowed_updates: ["message", "callback_query", "chat_member"],
  drop_pending_updates: true,
});

console.log("Bot started");
