import "dotenv/config";
import { Bot } from "grammy";
import { conversations } from "@grammyjs/conversations";
import { type MyContext, registerCommands } from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { getActiveCollectionsWithDeadline, getCollectionStatus, closeCollection } from "./db.js";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment");
}

const bot = new Bot<MyContext>(process.env.BOT_TOKEN);

// Install conversations plugin
bot.use(conversations());

// Register handlers (chat_member tracking, /start deep link, photo handling)
registerHandlers(bot);

// Register commands (/newcollect, /status, /confirm, /reject, /remind, /close)
registerCommands(bot);

// --- Deadline auto-reminders (every hour) ---

function checkDeadlines() {
  const collections = getActiveCollectionsWithDeadline();
  const now = new Date();

  for (const collection of collections) {
    const deadline = new Date(collection.deadline! + "T23:59:59");
    const msLeft = deadline.getTime() - now.getTime();
    const hoursLeft = msLeft / (1000 * 60 * 60);

    if (hoursLeft < 0) {
      // Deadline passed — close and notify
      closeCollection(collection.id);
      const { paid, unpaid } = getCollectionStatus(collection.id);
      bot.api
        .sendMessage(
          collection.group_id,
          `⏰ Дедлайн сбора "${collection.title}" прошёл. Сбор закрыт.\nСдали: ${paid.length}, не сдали: ${unpaid.length}.`,
        )
        .catch(() => {});
    } else if (hoursLeft <= 24) {
      // Less than 24h — remind
      const { unpaid } = getCollectionStatus(collection.id);
      if (unpaid.length > 0) {
        const mentions = unpaid.map((m) => (m.username ? `@${m.username}` : m.first_name)).join(", ");
        bot.api
          .sendMessage(
            collection.group_id,
            `⏰ До дедлайна сбора "${collection.title}" меньше суток!\n\nЖдём оплату от: ${mentions}\nСумма: ${collection.amount}\nРеквизиты: ${collection.details}`,
          )
          .catch(() => {});
      }
    }
  }
}

setInterval(checkDeadlines, 60 * 60 * 1000); // every hour

// Start bot
bot.start({
  allowed_updates: ["message", "callback_query", "chat_member"],
});

console.log("Bot started");
