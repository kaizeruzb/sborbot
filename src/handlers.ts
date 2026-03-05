import { Bot, Context, InlineKeyboard } from "grammy";
import {
  upsertMember, deactivateMember, upsertGroup,
  getCollectionById, addPayment, getPayment, updatePaymentStatus,
  getActiveCollectionsForUser, getCollectionStatus, closeCollection,
  deletePayment,
} from "./db.js";
import {
  isAdmin, adminFlow, pendingRejects, pendingAmountEdit, handleAdminText,
  sendReminder, doClose, formatMoney, buildPaymentListMessage,
} from "./commands.js";

// In-memory: userId -> collectionId they're about to send a screenshot for
const pendingScreenshots = new Map<number, number>();

export function registerHandlers(bot: Bot) {
  // --- Track groups and members from messages ---
  bot.on("message", (ctx, next) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      upsertGroup(ctx.chat.id, ctx.chat.title || "Unnamed");
      if (ctx.from) {
        upsertMember(ctx.from.id, ctx.chat.id, ctx.from.first_name, ctx.from.username);
      }
    }
    return next();
  });

  // --- Track via chat_member events ---
  bot.on("chat_member", (ctx) => {
    const groupId = ctx.chat.id;
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      upsertGroup(groupId, ctx.chat.title || "Unnamed");
    }
    const member = ctx.chatMember.new_chat_member;
    if (member.status === "member" || member.status === "administrator" || member.status === "creator") {
      upsertMember(member.user.id, groupId, member.user.first_name, member.user.username);
    } else if (member.status === "left" || member.status === "kicked") {
      deactivateMember(member.user.id, groupId);
    }
  });

  // --- /start with deep link ---
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const payload = ctx.match;
    if (payload?.startsWith("pay_")) {
      const collectionId = parseInt(payload.slice(4));
      const collection = getCollectionById(collectionId);

      if (!collection || collection.status !== "active") {
        return ctx.reply("Этот сбор уже закрыт или не существует.");
      }

      // Track user as member of collection's group
      upsertMember(ctx.from!.id, collection.group_id, ctx.from!.first_name, ctx.from!.username);

      const existing = getPayment(collectionId, ctx.from!.id);
      if (existing?.status === "confirmed") {
        return ctx.reply("Ваша оплата уже подтверждена! ✅");
      }
      if (existing?.status === "pending") {
        return ctx.reply("Ваш скриншот уже отправлен и ожидает подтверждения от админа. ⏳");
      }

      pendingScreenshots.set(ctx.from!.id, collectionId);
      return ctx.reply(
        `Отправьте скриншот оплаты для сбора "${collection.title}"\n\n💵 Сумма: ${formatMoney(collection.per_person)}\n📋 Реквизиты: ${collection.details}`,
      );
    }

    if (isAdmin(ctx)) {
      await ctx.reply("Привет! Команды:\n/newcollect — создать сбор\n/status — статус сборов\n/payments — просмотр/удаление/изменение платежей\n/remind — напомнить\n/paid @user сумма — записать нал\n/close — закрыть сбор\n/history — история сборов\n/cancel — отменить действие");
    } else {
      await ctx.reply("Привет! Нажмите кнопку «Отправить скрин оплаты» в группе.");
    }
  });

  // --- Photo in DM → accept screenshot ---
  bot.on("message:photo", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    let collectionId = pendingScreenshots.get(ctx.from!.id);

    // Fallback: find active collection for user
    if (!collectionId) {
      const collections = getActiveCollectionsForUser(ctx.from!.id);
      if (collections.length === 1) {
        collectionId = collections[0].id;
      } else if (collections.length > 1) {
        return ctx.reply("У вас несколько активных сборов. Нажмите кнопку «Отправить скрин» в нужном сборе.");
      } else {
        return ctx.reply("Нет активных сборов. Нажмите кнопку «Отправить скрин» в группе.");
      }
    }

    const collection = getCollectionById(collectionId);
    if (!collection || collection.status !== "active") {
      pendingScreenshots.delete(ctx.from!.id);
      return ctx.reply("Этот сбор уже закрыт.");
    }

    // Track user as member of collection's group
    upsertMember(ctx.from!.id, collection.group_id, ctx.from!.first_name, ctx.from!.username);

    const fileId = ctx.message!.photo![ctx.message!.photo!.length - 1].file_id;
    addPayment(collectionId, ctx.from!.id, fileId, collection.per_person);
    pendingScreenshots.delete(ctx.from!.id);

    await ctx.reply("Скриншот получен! Ожидайте подтверждения от админа. ⏳");

    // Send to admin with confirm/reject buttons
    const name = ctx.from!.username ? `@${ctx.from!.username}` : ctx.from!.first_name;
    const kb = new InlineKeyboard()
      .text("✅ Подтвердить", `cfm:${collectionId}:${ctx.from!.id}`)
      .text("❌ Отклонить", `rej:${collectionId}:${ctx.from!.id}`);

    try {
      await ctx.api.sendPhoto(collection.admin_id, fileId, {
        caption: `Скрин от ${name}\nСбор: "${collection.title}"`,
        reply_markup: kb,
      });
    } catch { /* admin may not have started bot */ }
  });

  // --- Callback queries ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Group selection for /newcollect
    if (data.startsWith("grp:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const groupId = parseInt(data.slice(4));
      adminFlow.set(ctx.from!.id, { step: "title", groupId });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Группа выбрана. Введите название сбора:");
      return;
    }

    // Count OK for /newcollect
    if (data === "cntok") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const state = adminFlow.get(ctx.from!.id);
      if (!state || state.step !== "count") return ctx.answerCallbackQuery();
      const s = state;
      const perPerson = s.totalAmount / s.suggestedCount;
      adminFlow.set(ctx.from!.id, {
        step: "details", groupId: s.groupId, title: s.title,
        message: s.message, totalAmount: s.totalAmount, memberCount: s.suggestedCount,
      });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`Участников: ${s.suggestedCount}, по ${formatMoney(perPerson)} на чел.\n\nРеквизиты для оплаты:`);
      return;
    }

    // Count custom
    if (data === "cntcustom") {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const state = adminFlow.get(ctx.from!.id);
      if (!state || state.step !== "count") return ctx.answerCallbackQuery();
      adminFlow.set(ctx.from!.id, {
        step: "count_custom", groupId: state.groupId, title: state.title,
        message: state.message, totalAmount: state.totalAmount,
      });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Введите количество участников:");
      return;
    }

    // Confirm payment
    if (data.startsWith("cfm:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const [, colId, uId] = data.split(":");
      const collectionId = parseInt(colId);
      const targetUserId = parseInt(uId);
      const collection = getCollectionById(collectionId);

      // Ensure user is tracked as group member
      if (collection) {
        try {
          const chat = await ctx.api.getChat(targetUserId);
          if (chat.type === "private") {
            upsertMember(targetUserId, collection.group_id, chat.first_name || "Unknown", chat.username);
          }
        } catch { /* ignore */ }
      }

      updatePaymentStatus(collectionId, targetUserId, "confirmed");
      await ctx.answerCallbackQuery({ text: "Подтверждено!" });
      await ctx.editMessageCaption({
        caption: ctx.callbackQuery.message?.caption + "\n\n✅ ПОДТВЕРЖДЕНО",
      });

      // Notify user
      try {
        await ctx.api.sendMessage(targetUserId,
          `Ваша оплата для сбора "${collection?.title}" подтверждена! ✅`);
      } catch { /* ignore */ }

      // Auto-close if everyone paid
      if (collection) {
        const { pending, knownUnpaid, unknownUnpaidCount } = getCollectionStatus(collectionId);
        if (pending.length === 0 && knownUnpaid.length === 0 && unknownUnpaidCount === 0) {
          closeCollection(collectionId);
          await ctx.api.sendMessage(collection.group_id,
            `🎉 Сбор "${collection.title}" завершён! Все сдали!`);
          await ctx.reply(`🎉 Все сдали! Сбор "${collection.title}" автоматически закрыт.`);
        }
      }
      return;
    }

    // Reject payment
    if (data.startsWith("rej:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const [, colId, uId] = data.split(":");
      pendingRejects.set(ctx.from!.id, {
        collectionId: parseInt(colId),
        userId: parseInt(uId),
      });
      await ctx.answerCallbackQuery();
      await ctx.editMessageCaption({
        caption: ctx.callbackQuery.message?.caption + "\n\n❌ ОТКЛОНЯЕТСЯ...",
      });
      await ctx.reply("Введите причину отклонения:");
      return;
    }

    // Remind callback (multi-collection selection)
    if (data.startsWith("rem:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const collectionId = parseInt(data.slice(4));
      const collection = getCollectionById(collectionId);
      if (!collection) return ctx.answerCallbackQuery({ text: "Сбор не найден" });
      await ctx.answerCallbackQuery();
      await sendReminder(ctx, collection);
      return;
    }

    // Close callback
    if (data.startsWith("cls:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const collectionId = parseInt(data.slice(4));
      const collection = getCollectionById(collectionId);
      if (!collection) return ctx.answerCallbackQuery({ text: "Сбор не найден" });
      await ctx.answerCallbackQuery();
      await doClose(ctx, collection);
      return;
    }

    // Payment management callbacks
    if (data.startsWith("pmt:")) {
      if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Нет доступа" });

      // Show payment list for a collection
      if (data.startsWith("pmt:col:")) {
        const collectionId = parseInt(data.slice(8));
        const { text, keyboard } = buildPaymentListMessage(collectionId);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, { reply_markup: keyboard });
        return;
      }

      // Ask for delete confirmation
      if (data.startsWith("pmt:del:")) {
        const [paymentId, colId] = data.slice(8).split(":").map(Number);
        const kb = new InlineKeyboard()
          .text("✅ Да, удалить", `pmt:delok:${paymentId}:${colId}`)
          .text("↩️ Отмена", `pmt:col:${colId}`);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText("Удалить этот платёж?", { reply_markup: kb });
        return;
      }

      // Confirm delete
      if (data.startsWith("pmt:delok:")) {
        const [paymentId, colId] = data.slice(10).split(":").map(Number);
        deletePayment(paymentId);
        const { text, keyboard } = buildPaymentListMessage(colId);
        await ctx.answerCallbackQuery({ text: "Платёж удалён" });
        await ctx.editMessageText(text, { reply_markup: keyboard });
        return;
      }

      // Request new amount
      if (data.startsWith("pmt:amt:")) {
        const [paymentId, colId] = data.slice(8).split(":").map(Number);
        pendingAmountEdit.set(ctx.from!.id, { paymentId, collectionId: colId });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText("Введите новую сумму:");
        return;
      }

      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // --- Admin DM text (state machine) — must call next() if not handled ---
  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !isAdmin(ctx)) return next();
    const handled = await handleAdminText(ctx);
    if (!handled) return next();
  });
}
