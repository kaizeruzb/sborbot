import "dotenv/config";
import { Bot } from "grammy";
import {
  handleNewCollect, handleStatus, handleRemind,
  handleClose, handleCancel, formatMoney,
} from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { getActiveCollectionsWithDeadline, getCollectionStatus, closeCollection } from "./db.js";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment");
}

const bot = new Bot(process.env.BOT_TOKEN);

// Event handlers (member tracking, /start, photos, callbacks, admin DM text)
registerHandlers(bot);

// Admin commands (DM only)
bot.command("newcollect", handleNewCollect);
bot.command("status", handleStatus);
bot.command("remind", handleRemind);
bot.command("close", handleClose);
bot.command("cancel", handleCancel);

// --- Deadline auto-reminders (every hour) ---

function checkDeadlines() {
  const collections = getActiveCollectionsWithDeadline();
  const now = new Date();

  for (const collection of collections) {
    const deadline = new Date(collection.deadline! + "T23:59:59");
    const hoursLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursLeft < 0) {
      closeCollection(collection.id);
      const { paid, pending, unpaid } = getCollectionStatus(collection.id);
      bot.api.sendMessage(collection.group_id,
        `⏰ Дедлайн сбора "${collection.title}" прошёл. Сбор закрыт.\n✅ ${paid.length} | ⏳ ${pending.length} | ❌ ${unpaid.length}`,
      ).catch(() => {});
    } else if (hoursLeft <= 24) {
      const { unpaid } = getCollectionStatus(collection.id);
      if (unpaid.length > 0) {
        const mentions = unpaid.map((m) => (m.username ? `@${m.username}` : m.first_name)).join(", ");
        bot.api.sendMessage(collection.group_id,
          `⏰ До дедлайна сбора "${collection.title}" меньше суток!\n\nЖдём: ${mentions}\nСумма: ${formatMoney(collection.per_person)}\nРеквизиты: ${collection.details}`,
        ).catch(() => {});
      }
    }
  }
}

setInterval(checkDeadlines, 60 * 60 * 1000);

bot.start({
  allowed_updates: ["message", "callback_query", "chat_member"],
});

console.log("Bot started");
