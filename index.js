import TelegramBot from 'node-telegram-bot-api';
import sqlite3 from 'sqlite3';
import CIDR from 'ip-cidr';
import dotenv from 'dotenv';

dotenv.config(); 

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Error opening database: ' + err.message);
  } else {
    db.run(`CREATE TABLE IF NOT EXISTS ip_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      cidr TEXT
    )`);
  }
});

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in environment variables');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

bot.getMe().then((me) => {
  console.log(`Bot started successfully! Bot name: ${me.username}`);
});

const helpMessage = `
Welcome to the IP & CIDR Manager Bot!

Available commands:
/start - Start the bot
/help - Show this help message
/add <IP or CIDR> - Add an IP address or CIDR
/delete <IP or CIDR> - Delete an IP address or CIDR
/list - List all stored IP addresses and CIDRs
/check <IP or CIDR> - Check if an IP address is within a stored CIDR or if a CIDR exists
/batchadd - Batch add multiple IP addresses or CIDRs
`;

bot.onText(/\/start|\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, helpMessage);
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const input = match[1].trim();

  const isCidr = CIDR.isValidCIDR(input);

  const query = `SELECT * FROM ip_addresses WHERE user_id = ? AND (ip_address = ? OR cidr = ?)`;

  db.get(query, [userId, input, isCidr ? "" : input], (err, row) => {
    if (err) {
      console.error(`Error checking if it exists: ${err.message}`, { userId, input, isCidr });
      bot.sendMessage(msg.chat.id, `Error checking if it exists: ${err.message}`);
      return;
    }

    if (row) {
      bot.sendMessage(msg.chat.id, `Address ${input} has already been added.`);
    } else {
      addEntry(userId, input, isCidr, (err) => {
        if (err) {
          console.error(`Error adding entry: ${err.message}`, { userId, input, isCidr });
          bot.sendMessage(msg.chat.id, `Error adding entry: ${err.message}`);
        } else {
          bot.sendMessage(msg.chat.id, `${isCidr ? 'CIDR' : 'IP address'} ${input} added successfully.`);
        }
      });
    }
  });
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  const userId = msg.from.id;
  const input = match[1].trim();

  db.run(`DELETE FROM ip_addresses WHERE user_id = ? AND (ip_address = ? OR cidr = ?)`, [userId, input, input], function(err) {
    if (err) {
      console.error(`Error deleting the entry: ${err.message}`, { userId, input });
      bot.sendMessage(msg.chat.id, `Error deleting the entry: ${err.message}`);
    } else if (this.changes > 0) {
      bot.sendMessage(msg.chat.id, `Entry ${input} deleted successfully.`);
    } else {
      bot.sendMessage(msg.chat.id, `No entry found for ${input}.`);
    }
  });
});

let listPage = {};

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  listPage[chatId] = 0;
  listIpAddresses(chatId, listPage[chatId]);
});

function listIpAddresses(chatId, page) {
  const limit = 10;
  const offset = page * limit;

  db.all(`SELECT * FROM ip_addresses LIMIT ? OFFSET ?`, [limit, offset], (err, rows) => {
    if (err) {
      console.error(`Error fetching list: ${err.message}`);
      bot.sendMessage(chatId, `Error fetching list: ${err.message}`);
      return;
    }

    const response = rows.map(row => `ID: ${row.id}, User: ${row.user_id}, IP: ${row.ip_address}, CIDR: ${row.cidr}`).join('\n');
    const paginationKeyboard = [];

    if (page > 0) {
      paginationKeyboard.push({ text: 'Previous', callback_data: `prev_page_${page}` });
    }
    if (rows.length === limit) {
      paginationKeyboard.push({ text: 'Next', callback_data: `next_page_${page}` });
    }

    bot.sendMessage(chatId, response || 'No entries found.', {
      reply_markup: {
        inline_keyboard: [paginationKeyboard]
      }
    });
  });
}

bot.on('callback_query', (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith('prev_page_') || data.startsWith('next_page_')) {
    const page = parseInt(data.split('_')[2]);
    const newPage = data.startsWith('prev_page_') ? page - 1 : page + 1;
    listPage[chatId] = newPage;
    listIpAddresses(chatId, newPage);
    bot.answerCallbackQuery(callbackQuery.id);
  } else if (data === 'confirm_batch_add' && batchAddData[chatId] && batchAddData[chatId].userId === callbackQuery.from.id) {
    const addresses = batchAddData[chatId].addresses;
    let successCount = 0;
    let errorCount = 0;

    const addPromises = addresses.map(address => {
      const isCidr = CIDR.isValidCIDR(address);
      return new Promise((resolve, reject) => {
        addEntry(callbackQuery.from.id, address, isCidr, (err) => {
          if (err) {
            console.error(`Error adding entry: ${err.message}`, { userId: callbackQuery.from.id, address, isCidr });
            errorCount++;
            resolve();
          } else {
            successCount++;
            resolve();
          }
        });
      });
    });

    Promise.all(addPromises).then(() => {
      bot.sendMessage(chatId, `Batch add completed. ${successCount} addresses added successfully, ${errorCount} errors.`);
      if (batchAddData[chatId].messageId) {
        bot.deleteMessage(chatId, batchAddData[chatId].messageId.toString());
      }
      delete batchAddData[chatId];
    });
  } else if (data === 'cancel_batch_add') {
    bot.sendMessage(chatId, 'Batch add cancelled.');
    if (batchAddData[chatId].messageId) {
      bot.deleteMessage(chatId, batchAddData[chatId].messageId.toString());
    }
    delete batchAddData[chatId];
  }
});

bot.onText(/\/check (.+)/, (msg, match) => {
  const input = match[1].trim();
  let found = false;

  db.all(`SELECT * FROM ip_addresses`, [], (err, rows) => {
    if (err) {
      console.error(`Error checking IP: ${err.message}`);
      bot.sendMessage(msg.chat.id, `Error checking IP: ${err.message}`);
      return;
    }

    if (CIDR.isValidCIDR(input)) {
      for (const row of rows) {
        if (row.cidr === input) {
          bot.sendMessage(msg.chat.id, `CIDR ${input} exists in your records.`);
          found = true;
          break;
        }
      }
      if (!found) {
        bot.sendMessage(msg.chat.id, `CIDR ${input} does not exist in your records.`);
      }
    } else {
      for (const row of rows) {
        if (row.ip_address === input || (CIDR.isValidCIDR(row.cidr) && new CIDR(row.cidr).contains(input))) {
          bot.sendMessage(msg.chat.id, `${input} is within CIDR ${row.cidr} from user ${row.user_id}`);
          found = true;
          break;
        }
      }
      if (!found) {
        bot.sendMessage(msg.chat.id, `${input} is not within any stored CIDR.`);
      }
    }
  });
});

let batchAddData = {};

bot.onText(/\/batchadd/, (msg) => {
  const chatId = msg.chat.id;
  batchAddData[chatId] = { userId: msg.from.id, addresses: [] };
  bot.sendMessage(chatId, 'Please send the IP addresses or CIDRs, one per line.');
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (batchAddData[chatId]) {
    const text = msg.text.trim();
    if (text) {
      const addresses = text.split('\n').map(line => line.trim()).filter(line => line);
      batchAddData[chatId].addresses = addresses;
      const confirmMessage = `Are you sure you want to add the following addresses?\n\n${addresses.join('\n')}`;
      bot.sendMessage(chatId, confirmMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yes', callback_data: 'confirm_batch_add' },
              { text: 'No', callback_data: 'cancel_batch_add' }
            ]
          ]
        }
      }).then((sentMessage) => {
        batchAddData[chatId].messageId = sentMessage.message_id;
      });
    } else {
      bot.sendMessage(chatId, 'No valid addresses found. Please try again.');
      delete batchAddData[chatId];
    }
  }
});

function addEntry(userId, input, isCidr, callback) {
  const column = isCidr ? 'cidr' : 'ip_address';
  const query = `INSERT INTO ip_addresses (user_id, ${column}) VALUES (?, ?)`;
  db.run(query, [userId, input], callback);
}

bot.on('polling_error', (error) => {
  console.error(`[polling_error] ${error.code}: ${error.message}`);
});
