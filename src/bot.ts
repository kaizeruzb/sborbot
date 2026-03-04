import "dotenv/config";
import { Bot } from "grammy";
import {
  handleNewCollect, handleStatus, handleRemind,
  handleClose, handleCancel, formatMoney,
} from "./commands.js";
import { registerHandlers } from "./handlers.js";
import { getActiveCollectionsWithDeadline, getCollectionStatus, closeCollection, getGroups, getActiveMembers, getActiveCollections, db } from "./db.js";
import { isAdmin } from "./commands.js";

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

// Temporary debug command
bot.command("debug", async (ctx) => {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;
  const groups = getGroups();
  const collections = getActiveCollections();
  const payments = db.prepare("SELECT * FROM payments").all() as any[];

  let text = `🔍 DEBUG\n\nGroups (${groups.length}):\n`;
  for (const g of groups) {
    const members = getActiveMembers(g.group_id);
    text += `  ${g.title} [${g.group_id}] — ${members.length} members\n`;
    for (const m of members) {
      text += `    ${m.first_name} (@${m.username}) id=${m.user_id}\n`;
    }
  }

  text += `\nCollections (${collections.length}):\n`;
  for (const c of collections) {
    text += `  #${c.id} "${c.title}" group=${c.group_id} admin=${c.admin_id}\n`;
  }

  text += `\nPayments (${payments.length}):\n`;
  for (const p of payments) {
    text += `  col=${p.collection_id} user=${p.user_id} status=${p.status}\n`;
  }

  await ctx.reply(text);
});

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
  drop_pending_updates: true,
});

console.log("Bot started");
