import "dotenv/config";
import { Bot } from "grammy";

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set in environment");
}

const bot = new Bot(process.env.BOT_TOKEN);

// Commands and handlers will be registered here as they are implemented

bot.start({
  allowed_updates: ["message", "callback_query", "chat_member"],
});

console.log("Bot started");
