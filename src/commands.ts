import { Context, InlineKeyboard } from "grammy";
import {
  createCollection, getActiveCollections, getCollectionById,
  getCollectionStatus, closeCollection, getGroups, getPayment,
  updatePaymentStatus, type Collection, type Member,
} from "./db.js";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "CPO_FIN";

export function isAdmin(ctx: Context): boolean {
  return ctx.from?.username === ADMIN_USERNAME;
}

export function formatMoney(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// --- Admin flow state machine ---

type FlowState =
  | { step: "title"; groupId: number }
  | { step: "message"; groupId: number; title: string }
  | { step: "amount"; groupId: number; title: string; message: string }
  | { step: "count"; groupId: number; title: string; message: string; totalAmount: number; suggestedCount: number }
  | { step: "count_custom"; groupId: number; title: string; message: string; totalAmount: number }
  | { step: "details"; groupId: number; title: string; message: string; totalAmount: number; memberCount: number }
  | { step: "deadline"; groupId: number; title: string; message: string; totalAmount: number; memberCount: number; details: string };

export const adminFlow = new Map<number, FlowState>();
export const pendingRejects = new Map<number, { collectionId: number; userId: number }>();

// --- Handle admin text in DM (state machine) ---

export async function handleAdminText(ctx: Context): Promise<boolean> {
  const adminId = ctx.from!.id;
  const text = ctx.message?.text?.trim();
  if (!text) return false;

  // Priority 1: pending reject reason
  if (pendingRejects.has(adminId)) {
    const { collectionId, userId } = pendingRejects.get(adminId)!;
    pendingRejects.delete(adminId);

    const collection = getCollectionById(collectionId);
    updatePaymentStatus(collectionId, userId, "rejected", text);

    // Notify user
    try {
      const botInfo = await ctx.api.getMe();
      const kb = new InlineKeyboard().url(
        "💳 Отправить новый скрин",
        `https://t.me/${botInfo.username}?start=pay_${collectionId}`,
      );
      await ctx.api.sendMessage(userId,
        `❌ Ваш скриншот для сбора "${collection?.title}" отклонён.\nПричина: ${text}\n\nОтправьте новый:`,
        { reply_markup: kb },
      );
    } catch { /* user may not have started bot */ }

    await ctx.reply(`❌ Скрин отклонён. Пользователь уведомлён.`);

    // Remind about ongoing flow
    const state = adminFlow.get(adminId);
    if (state) {
      await ctx.reply(`↩️ Продолжаем создание сбора. ${stepPrompt(state)}`);
    }
    return true;
  }

  // Priority 2: admin flow
  const state = adminFlow.get(adminId);
  if (!state) return false;

  switch (state.step) {
    case "title":
      adminFlow.set(adminId, { step: "message", groupId: state.groupId, title: text });
      await ctx.reply("Введите описание для участников (что собираем, расчёты, ссылки — всё в одном сообщении):");
      return true;

    case "message":
      adminFlow.set(adminId, { step: "amount", groupId: state.groupId, title: state.title, message: text });
      await ctx.reply("Общая сумма сбора (число):");
      return true;

    case "amount": {
      const amount = parseFloat(text.replace(/\s/g, "").replace(/,/g, "."));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply("Введите число больше 0:");
        return true;
      }

      let suggestedCount = 0;
      try {
        const total = await ctx.api.getChatMemberCount(state.groupId);
        suggestedCount = total - 2; // minus bot and admin
        if (suggestedCount < 1) suggestedCount = 1;
      } catch { /* can't get count */ }

      if (suggestedCount > 0) {
        const perPerson = amount / suggestedCount;
        adminFlow.set(adminId, { ...state, step: "count", totalAmount: amount, suggestedCount });
        const kb = new InlineKeyboard()
          .text(`✅ Да, ${suggestedCount} чел. (${formatMoney(perPerson)} на чел.)`, "cntok")
          .row()
          .text("✏️ Ввести своё число", "cntcustom");
        await ctx.reply(`В группе ${suggestedCount} участников (без бота и вас).`, { reply_markup: kb });
      } else {
        adminFlow.set(adminId, { ...state, step: "count_custom", totalAmount: amount });
        await ctx.reply("Не удалось определить кол-во участников. Введите число:");
      }
      return true;
    }

    case "count_custom": {
      const count = parseInt(text);
      if (isNaN(count) || count < 1) {
        await ctx.reply("Введите число больше 0:");
        return true;
      }
      adminFlow.set(adminId, { step: "details", groupId: state.groupId, title: state.title, message: state.message, totalAmount: state.totalAmount, memberCount: count });
      const pp = state.totalAmount / count;
      await ctx.reply(`Сумма на человека: ${formatMoney(pp)}\n\nРеквизиты для оплаты:`);
      return true;
    }

    case "details":
      adminFlow.set(adminId, { step: "deadline", groupId: state.groupId, title: state.title, message: state.message, totalAmount: state.totalAmount, memberCount: state.memberCount, details: text });
      await ctx.reply("Дедлайн (ДД.ММ или ДД.ММ.ГГГГ, или «нет»):");
      return true;

    case "deadline": {
      const s = state;
      let deadline: string | undefined;
      if (text !== "нет" && text !== "-" && text !== "no") {
        const m = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
        if (m) {
          const year = m[3] || new Date().getFullYear().toString();
          deadline = `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        }
      }

      const perPerson = s.totalAmount / s.memberCount;
      const result = createCollection(
        s.groupId, adminId, s.title, s.message,
        s.totalAmount, s.memberCount, perPerson,
        s.details, deadline,
      );
      const collectionId = result.lastInsertRowid as number;
      adminFlow.delete(adminId);

      // Post announcement to group
      const botInfo = await ctx.api.getMe();
      const kb = new InlineKeyboard().url(
        "💳 Отправить скрин оплаты",
        `https://t.me/${botInfo.username}?start=pay_${collectionId}`,
      );

      const deadlineText = deadline
        ? deadline.split("-").reverse().join(".")
        : "не указан";

      let groupMsg = `💰 Новый сбор: "${s.title}"\n\n`;
      groupMsg += s.message + "\n\n";
      groupMsg += `💵 Сумма на человека: ${formatMoney(perPerson)}\n`;
      groupMsg += `📋 Реквизиты: ${s.details}\n`;
      groupMsg += `⏰ Дедлайн: ${deadlineText}`;

      await ctx.api.sendMessage(s.groupId, groupMsg, { reply_markup: kb });
      await ctx.reply(`✅ Сбор "${s.title}" создан и отправлен в группу!\nСумма на человека: ${formatMoney(perPerson)}`);
      return true;
    }

    default:
      return false;
  }
}

function stepPrompt(state: FlowState): string {
  switch (state.step) {
    case "title": return "Название сбора?";
    case "message": return "Описание для участников?";
    case "amount": return "Общая сумма сбора (число)?";
    case "count_custom": return "Количество участников?";
    case "details": return "Реквизиты?";
    case "deadline": return "Дедлайн (ДД.ММ или «нет»)?";
    default: return "";
  }
}

// --- /newcollect ---

export async function handleNewCollect(ctx: Context) {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;

  const groups = getGroups();
  if (groups.length === 0) {
    return ctx.reply("Бот пока не добавлен ни в одну группу. Добавьте бота в группу, и пусть кто-нибудь напишет там сообщение.");
  }

  adminFlow.delete(ctx.from!.id); // reset any ongoing flow

  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(g.title, `grp:${g.group_id}`).row();
  }
  await ctx.reply("Выберите группу для сбора:", { reply_markup: kb });
}

// --- /status ---

export async function handleStatus(ctx: Context) {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;

  const collections = getActiveCollections();
  if (collections.length === 0) {
    return ctx.reply("Нет активных сборов.");
  }

  const groups = getGroups();
  const groupMap = new Map(groups.map((g) => [g.group_id, g.title]));

  for (const c of collections) {
    const { paid, pending, knownUnpaid, unknownUnpaidCount } = getCollectionStatus(c.id);
    const totalUnpaid = knownUnpaid.length + unknownUnpaidCount;
    const groupName = groupMap.get(c.group_id) || "?";

    let text = `📊 Сбор "${c.title}" (${groupName})\n`;
    text += `💵 ${formatMoney(c.per_person)} на чел. | Всего: ${formatMoney(c.total_amount)}\n\n`;

    text += `✅ Сдали (${paid.length}):\n`;
    text += paid.length > 0
      ? paid.map((m) => `  ${m.first_name}${m.username ? ` (@${m.username})` : ""}`).join("\n")
      : "  —";

    text += `\n⏳ На проверке (${pending.length}):\n`;
    text += pending.length > 0
      ? pending.map((m) => `  ${m.first_name}${m.username ? ` (@${m.username})` : ""}`).join("\n")
      : "  —";

    text += `\n❌ Не сдали (~${totalUnpaid}):\n`;
    text += knownUnpaid.length > 0
      ? knownUnpaid.map((m) => `  ${m.first_name}${m.username ? ` (@${m.username})` : ""}`).join("\n")
      : "  —";
    if (unknownUnpaidCount > 0) {
      text += `\n  ...и ещё ~${unknownUnpaidCount} чел.`;
    }

    await ctx.reply(text);
  }
}

// --- /remind ---

export async function handleRemind(ctx: Context) {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;

  const collections = getActiveCollections();
  if (collections.length === 0) return ctx.reply("Нет активных сборов.");

  if (collections.length === 1) {
    await sendReminder(ctx, collections[0]);
  } else {
    const kb = new InlineKeyboard();
    for (const c of collections) {
      kb.text(c.title, `rem:${c.id}`).row();
    }
    await ctx.reply("Для какого сбора напомнить?", { reply_markup: kb });
  }
}

export async function sendReminder(ctx: Context, collection: Collection) {
  const { knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collection.id);
  if (knownUnpaid.length === 0 && unknownUnpaidCount === 0) {
    return ctx.reply(`Все участники сбора "${collection.title}" уже сдали! 🎉`);
  }

  const mentions = knownUnpaid.map((m) => (m.username ? `@${m.username}` : m.first_name)).join(", ");
  const botInfo = await ctx.api.getMe();
  const kb = new InlineKeyboard().url(
    "💳 Отправить скрин оплаты",
    `https://t.me/${botInfo.username}?start=pay_${collection.id}`,
  );

  await ctx.api.sendMessage(collection.group_id,
    `⏰ Напоминание! Ждём оплату от: ${mentions}\n\nСбор: "${collection.title}"\nСумма: ${formatMoney(collection.per_person)}\nРеквизиты: ${collection.details}`,
    { reply_markup: kb },
  );
  await ctx.reply(`Напоминание отправлено в группу (не сдали: ~${knownUnpaid.length + unknownUnpaidCount}).`);
}

// --- /close ---

export async function handleClose(ctx: Context) {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;

  const collections = getActiveCollections();
  if (collections.length === 0) return ctx.reply("Нет активных сборов.");

  if (collections.length === 1) {
    await doClose(ctx, collections[0]);
  } else {
    const kb = new InlineKeyboard();
    for (const c of collections) {
      kb.text(c.title, `cls:${c.id}`).row();
    }
    await ctx.reply("Какой сбор закрыть?", { reply_markup: kb });
  }
}

export async function doClose(ctx: Context, collection: Collection) {
  closeCollection(collection.id);
  const { paid, pending, knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collection.id);
  await ctx.api.sendMessage(collection.group_id,
    `Сбор "${collection.title}" закрыт.\n✅ Сдали: ${paid.length} | ⏳ На проверке: ${pending.length} | ❌ Не сдали: ~${knownUnpaid.length + unknownUnpaidCount}`,
  );
  await ctx.reply(`Сбор "${collection.title}" закрыт.`);
}

// --- /cancel ---

export async function handleCancel(ctx: Context) {
  if (ctx.chat?.type !== "private" || !isAdmin(ctx)) return;
  adminFlow.delete(ctx.from!.id);
  pendingRejects.delete(ctx.from!.id);
  await ctx.reply("Действие отменено.");
}
