const http = require('http');
const https = require('https');

const GREEN_INSTANCE = process.env.GREEN_INSTANCE;
const GREEN_TOKEN = process.env.GREEN_TOKEN;
const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST = process.env.TRELLO_LIST;
const OPENAI_KEY = process.env.OPENAI_KEY;

// Session storage: phone -> { messages: [], trelloCreated: false }
const sessions = {};

let lastPollTime = null;
let lastPollError = null;
let messagesProcessed = 0;

const SYSTEM_PROMPT = `אתה נציג מכירות של Cohen Design — חברה לרהיטים בהתאמה אישית בישראל.
אנחנו מייצרים: ספות, שולחנות, מראות, שידות, מזנונים, ספריות, כיסאות — מעץ, ברזל, שיש וזכוכית.
כל פרויקט מותאם אישית מהתכנון ועד ההתקנה.

האופי שלך: חם, מקצועי, ישיר. עונה בעברית בלבד. משפטים קצרים.

המטרה שלך: לאסוף מלקוח חדש את הפרטים הבאים:
1. שם מלא
2. עיר/אזור
3. מה המוצר שהוא מחפש
4. מידות משוערות
5. תקציב משוער בש"ח

כשיש לך את כל 5 הפרטים — ענה עם הודעת סיום ובסוף הוסף את השורה:
TRELLO_READY|שם|עיר|מוצר|מידות|תקציב

כללים חשובים:
- לקוח חדש? התחל לאסוף פרטים בצורה טבעית ולא כמו שאלון
- לקוח ישן שעושה follow up? ענה "אדיר יחזור אליך בהקדם, תודה על הסבלנות 🙏"
- שאלות על מחיר? ענה "המחיר תלוי בחומר ומידות — אדיר ישלח הצעה אישית אחרי שנדע פרטים"
- שאלות על זמן אספקה? ענה "בדרך כלל 3-6 שבועות ממועד אישור"
- אל תמציא מחירים ספציפיים
- אל תשאל יותר משאלה אחת בכל פעם`;

function httpsReq(method, hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname, path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      let result = '';
      res.on('data', c => result += c);
      res.on('end', () => resolve({ status: res.statusCode, body: result }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function askGPT(messages) {
  const res = await httpsReq('POST', 'api.openai.com', '/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    max_tokens: 300,
    temperature: 0.7
  }, { Authorization: `Bearer ${OPENAI_KEY}` });

  const data = JSON.parse(res.body);
  return data.choices?.[0]?.message?.content || 'סליחה, אנסה שוב';
}

async function sendMsg(chatId, message) {
  const res = await httpsReq('POST',
    'api.green-api.com',
    `/waInstance${GREEN_INSTANCE}/sendMessage/${GREEN_TOKEN}`,
    { chatId, message }
  );
  console.log('Sent to', chatId, '| status:', res.status);
  return res.status;
}

async function deleteNotification(receiptId) {
  await httpsReq('DELETE',
    'api.green-api.com',
    `/waInstance${GREEN_INSTANCE}/deleteNotification/${GREEN_TOKEN}/${receiptId}`
  );
}

async function createTrelloCard(name, city, product, dims, budget, phone) {
  const now = new Date().toLocaleDateString('he-IL');
  const cardName = encodeURIComponent(`${name} - ${now}`);
  const desc = encodeURIComponent(
    `📱 טלפון: ${phone.replace('@c.us', '')}\n👤 שם: ${name}\n🏠 עיר: ${city}\n🛋️ מוצר: ${product}\n📐 מידות: ${dims}\n💰 תקציב: ${budget} ₪\n📅 תאריך: ${now}`
  );
  const res = await httpsReq('POST', 'api.trello.com',
    `/1/cards?idList=${TRELLO_LIST}&name=${cardName}&desc=${desc}&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
    {}
  );
  console.log('Trello card created:', res.status);
  return res.status;
}

async function processMessage(sender, chatId, text) {
  if (!sender || !text) return;
  if (chatId?.includes('@g.us')) return; // Skip groups

  console.log('Processing:', sender, '|', text.substring(0, 60));

  if (!sessions[sender]) sessions[sender] = { messages: [], trelloCreated: false };
  const session = sessions[sender];

  session.messages.push({ role: 'user', content: text });
  if (session.messages.length > 20) session.messages = session.messages.slice(-20);

  const reply = await askGPT(session.messages);

  if (reply.includes('TRELLO_READY|') && !session.trelloCreated) {
    const parts = reply.split('TRELLO_READY|')[1]?.split('|');
    if (parts?.length >= 5) {
      const [name, city, product, dims, budget] = parts;
      await createTrelloCard(name, city, product, dims, budget.replace(/\n.*/,''), sender);
      session.trelloCreated = true;
      setTimeout(() => { delete sessions[sender]; }, 60 * 60 * 1000);
    }
  }

  const cleanReply = reply.split('TRELLO_READY|')[0].trim();
  session.messages.push({ role: 'assistant', content: cleanReply });

  await sendMsg(chatId || sender, cleanReply);
  messagesProcessed++;
}

// POLLING — check every 3 seconds
async function poll() {
  try {
    const res = await httpsReq('GET',
      'api.green-api.com',
      `/waInstance${GREEN_INSTANCE}/receiveNotification/${GREEN_TOKEN}`
    );
    lastPollTime = new Date().toISOString();

    if (res.status === 200 && res.body && res.body !== 'null') {
      const d = JSON.parse(res.body);
      if (d && d.receiptId) {
        await deleteNotification(d.receiptId);

        const body = d.body || {};
        if (body.typeWebhook === 'incomingMessageReceived') {
          const sender = body.senderData?.sender;
          const chatId = body.senderData?.chatId || sender;
          const text = (body.messageData?.textMessageData?.textMessage || '').trim();
          await processMessage(sender, chatId, text);
        }
      }
    } else if (res.status === 400) {
      lastPollError = 'Webhook URL is set — clear it in console.green-api.com';
      console.error('POLL ERROR: webhook URL is set, polling blocked!');
    }
  } catch (e) {
    lastPollError = e.message;
    console.error('Poll error:', e.message);
  }
}

setInterval(poll, 3000);
console.log('Polling started (every 3s)');

// HTTP server for health checks
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      GREEN_INSTANCE: !!GREEN_INSTANCE,
      OPENAI_KEY: !!OPENAI_KEY,
      lastPoll: lastPollTime,
      lastError: lastPollError,
      messagesProcessed,
      sessions: Object.keys(sessions).length
    }));
  }

  if (req.url === '/test') {
    try {
      const reply = await askGPT([{ role: 'user', content: 'שלום, אני מתעניין בשולחן סלון' }]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(200);
  res.end('OK');
});

const PORT = process.env.PORT || 3847;
server.listen(PORT, () => console.log(`Cohen Design Bot | PORT:${PORT} | GPT:${!!OPENAI_KEY} | Instance:${GREEN_INSTANCE}`));
