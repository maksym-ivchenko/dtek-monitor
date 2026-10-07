import { chromium } from "playwright"

import {
  HOUSE,
  SHUTDOWNS_PAGE,
  STREET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} from "./constants.js"

import {
  capitalize,
  deleteLastMessage,
  loadLastMessage,
  saveLastMessage,
} from "./helpers.js"

async function getInfo() {
  console.log("🌀 Getting info...")

  const browser = await chromium.launch({ headless: true })
  const browserPage = await browser.newPage()

  try {
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const csrfTokenTag = await browserPage.waitForSelector(
      'meta[name="csrf-token"]',
      { state: "attached" }
    )
    const csrfToken = await csrfTokenTag.getAttribute("content")

    const info = await browserPage.evaluate(
      async ({ STREET, csrfToken }) => {
        const formData = new URLSearchParams()
        formData.append("method", "getHomeNum")
        formData.append("data[0][name]", "street")
        formData.append("data[0][value]", STREET)
        formData.append("data[1][name]", "updateFact")
        formData.append("data[1][value]", new Date().toLocaleString("uk-UA"))

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": csrfToken,
          },
          body: formData,
        })
        return await response.json()
      },
      { STREET, csrfToken }
    )

    console.log("✅ Getting info finished.")
    return info
  } catch (error) {
    throw Error(`❌ Getting info failed: ${error.message}`)
  } finally {
    await browser.close()
  }
}

function checkIsOutage(info) {
  console.log("🌀 Checking power outage...")

  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const { sub_type, start_date, end_date, type } = info?.data?.[HOUSE] || {}
  const isOutageDetected =
    sub_type !== "" || start_date !== "" || end_date !== "" || type !== ""

  isOutageDetected
    ? console.log("🚨 Power outage detected!")
    : console.log("⚡️ No power outage!")

  return isOutageDetected
}

function checkIsScheduled(info) {
  console.log("🌀 Checking whether power outage scheduled...")

  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const { sub_type = "" } = info?.data?.[HOUSE] || {}
  const isScheduled = !sub_type.toLowerCase().includes("екстрен") && !sub_type.toLowerCase().includes("аварій")

  isScheduled
    ? console.log("🗓️ Power outage scheduled!")
    : console.log("⚠️ Power outage not scheduled!")

  return isScheduled
}

function checkSubTypeReason(info) {
  console.log("🌀 Checking sub_type_reason...")

  if (!info?.data) {
    throw Error("❌ Power outage info missed.")
  }

  const { sub_type_reason = [] } = info?.data?.[HOUSE] || {}

  const hasNonStandardReason = !(
    Array.isArray(sub_type_reason) &&
    sub_type_reason.length === 1 &&
    sub_type_reason[0] === "GPV35.1"
  )

  hasNonStandardReason
    ? console.log(`🚨 Non-standard sub_type_reason: ${JSON.stringify(sub_type_reason)}`)
    : console.log("⚡️ Standard sub_type_reason: GPV35.1")

  return hasNonStandardReason
}

function generateMessage(info) {
  console.log("🌀 Generating message...")

  const { sub_type, start_date, end_date } = info?.data?.[HOUSE] || {}
  const { updateTimestamp } = info || {}

  const reason = capitalize(sub_type)
  //const begin = start_date.split(" ")[0]
  //const end = end_date.split(" ")[0]

  return [
    `⚡️ <b>За адресою ${STREET}, ${HOUSE} зафіксовано відключення</b>`,
    "",
    `🪫 Час початку - ${start_date}`,
    `🔌 Орієнтовний час відновлення - ${end_date}`,
    "",
    `⚠️ <i>${reason}.</i>`,
    "\n",
    `🔄 <i>Дата оновлення інформації – ${updateTimestamp}</i>`
  ].join("\n")
}

function generateSubTypeReasonMessage(info) {
  const { sub_type_reason = [] } = info?.data?.[HOUSE] || {}
  const reason = sub_type_reason.join(", ") || "невідома"

  return `🔄 <b>Змінилась черга відключень на ${reason}</b>`
}

async function sendNotification(message, currentEndDate) {
  if (!TELEGRAM_BOT_TOKEN)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessage() || {}
  const isTimeChanged = lastMessage.end_date && lastMessage.end_date !== currentEndDate
  const messageIdToEdit = isTimeChanged ? undefined : lastMessage.message_id

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${
        messageIdToEdit ? "editMessageText" : "sendMessage"
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          message_id: messageIdToEdit,
        }),
      }
    )

    const data = await response.json()

    if (data.ok) {
      saveLastMessage({
        message_id: data.result.message_id,
        date: data.result.date,
        end_date: currentEndDate
      })
      console.log(isTimeChanged ? "🟢 Notification sent." : "🟢 Notification updated.")
    }
  } catch (error) {
    console.log("🔴 Notification not sent.", error.message)
    deleteLastMessage()
  }
}

async function sendSubTypeReasonNotification(message) {
  if (!TELEGRAM_BOT_TOKEN)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending sub_type_reason notification...")

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    )

    const data = await response.json()

    if (!data.ok) {
      throw Error(data.description || "Telegram API error")
    }

    console.log("🟢 Sub_type_reason notification sent.")
  } catch (error) {
    console.log("🔴 Sub_type_reason notification not sent.", error.message)
  }
}

async function run() {
  const info = await getInfo()
  const isOutage = checkIsOutage(info)
  const isScheduled = checkIsScheduled(info)
  const hasNonStandardReason = checkSubTypeReason(info)

  if (isOutage && !isScheduled) {
    const message = generateMessage(info)
    const { end_date } = info?.data?.[HOUSE] || {}
    await sendNotification(message, end_date)
  }

  if (hasNonStandardReason) {
    const message = generateSubTypeReasonMessage(info)
    await sendSubTypeReasonNotification(message)
  }
}

run().catch((error) => console.error(error.message))
