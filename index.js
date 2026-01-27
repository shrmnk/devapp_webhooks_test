require('dotenv').config()
const Koa = require('koa');
const Router = require('@koa/router');
const koaBody = require('koa-body');
const ollamaLib = require('ollama');
const ollama = new ollamaLib.Ollama({
    host: process.env.OLLAMA_HOST,
});

// Helper function to send messages via Messenger Send API
async function sendMessengerMessage(recipientId, mid, messageText) {
    const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;
    const pageId = process.env.PAGE_ID;
    if (!pageAccessToken) {
        console.error('[Messenger] PAGE_ACCESS_TOKEN not configured');
        return null;
    }

    const requestBody = {
        messaging_type: 'RESPONSE',
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText
        },
        reply_to: {
            mid
        }
    };

    try {
        const response = await fetch(
            `https://graph.facebook.com/v21.0/${pageId}/messages`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${pageAccessToken}`,
                },
                body: JSON.stringify(requestBody),
            }
        );

        const result = await response.json();

        if (!response.ok) {
            console.error('[Messenger] Send API error:', result);
            return null;
        }

        console.log('[Messenger] Message sent successfully:', result);
        return result;
    } catch (error) {
        console.error('[Messenger] Failed to send message:', error);
        return null;
    }
}

const app = new Koa({
    proxy: true,
    // Uncomment if you are using Cloudflare
    proxyIpHeader: 'CF-Connecting-IP'
});
const router = new Router();

// Keep a maximum here so we don't use up all the memory
const maxUpdates = 100;
var receivedUpdates = [];
var lastUpdated = Date.now();

// Uncomment if you wish to validate Event Notifications, and add as a middleware *before* koaBody() in the POST webhooks route
// i.e. `router.post('/webhooks', validateXHub, koaBody(), async (ctx, next) => {`
// Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
// const crypto = require('crypto');
// const sigHeaderName = 'X-Hub-Signature-256'
// const sigHashAlg = 'sha256'
// const sigSecret = process.env.APP_SECRET;
// const validateXHub = async (ctx, next) => {
//     if (sigSecret != null) {
//         console.log('Validating X-Hub');
//         const sig = ctx.request.header[sigHeaderName];
//         if (sig != null) {
//             console.log('X-Hub Header found, proceeding to validate');
//             const hmac = crypto.createHmac(sigHashAlg, sigSecret);
//             const digest = Buffer.from(sigHashAlg + '=' + hmac.update(ctx.request.body).digest('hex'), 'utf8');
//             if (sig.length !== digest.length || !crypto.timingSafeEqual(digest, sig)) {
//                 ctx.status = 401;
//                 console.log('X-Hub token is INVALID');
//                 ctx.body(`Received webhooks update with invalid ${sigHeaderName}`);
//                 await next(`Received webhooks update with invalid ${sigHeaderName}`);
//             } else {
//                 console.log('X-Hub token is validated successfully');
//             }
//         }
//     } else {
//         console.log('APP_SECRET not specified; avoiding validation of X-Hub');
//     }
//     await next();
// }

// Logging
app.use(async (ctx, next) => {
    await next();
    const rt = ctx.response.get('X-Response-Time');
    console.log(`${ctx.method} ${ctx.url} - ${rt}`);
});

// Add headers
app.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    ctx.set('X-Response-Time', `${ms}ms`);
    ctx.set('X-Cached-Usage', `${receivedUpdates.length}/${maxUpdates}`);
    ctx.set('X-Previous-Update-Timestamp', `${lastUpdated}`);
    lastUpdated = Date.now();
});

// The root page should just return the latest webhook data
router.get('/', (ctx) => {
    ctx.body = `<head><title>Webhooks</title></head><body><h3>Total Updates: ${receivedUpdates.length}&nbsp;<small>Caching only ${maxUpdates} updates</small></h3>
    ${receivedUpdates.map((update, idx) => `<strong>${idx + 1}</strong><pre>${JSON.stringify(update, null, 2)}</pre>`).join('<hr />')}</body>`
});

// The webhook registration page
router.get('/webhooks', (ctx) => {
    // Processed according to https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
    const queryParams = ctx.request.query;
    if (queryParams['hub.mode'] === 'subscribe' && queryParams['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        ctx.body = queryParams['hub.challenge'];
        return;
    }
    ctx.status = 403; // https://developers.facebook.com/docs/messenger-platform/webhooks
    ctx.body = 'hub.mode is not `subscribe`, or hub.verify_token does not match the provided environment\'s value';
});

// Parsing incoming webhooks, which relies on koaBody to parse JSON
router.post('/webhooks', koaBody(), async (ctx, next) => {
    ctx.accepts('json');
    console.log(`Received webhook data: `, ctx.request.body);
    const currentDate = new Date();
    receivedUpdates.unshift({ "TIME": currentDate, "TIMESTAMP": currentDate.valueOf(), "IP_ADDRESS": ctx.request.ip, "role": "user", "BODY": ctx.request.body });
    ctx.status = 200;
    ctx.body = 'Received';

    const isMessagingAPI = ctx.request.body?.object === 'page' && (ctx.request.body?.entry?.[0]?.messaging?.length ?? 0) > 0;
    if(isMessagingAPI) {
        console.log('receivedUpdates', receivedUpdates);

        // Extract sender ID for replying
        const senderId = ctx.request.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
        const mid = ctx.request.body?.entry?.[0]?.messaging?.[0]?.message?.mid;
        console.log('[Messenger] Sender ID:', senderId);

        const messagesOnly = receivedUpdates.filter(
            (message) => message.role === 'assistant'
                || (message.role === 'user' && message.BODY?.object === 'page' && (message.BODY?.entry?.[0]?.messaging?.length ?? 0) > 0)
        );
        console.log('messagesOnly', messagesOnly);

        const messages = messagesOnly.map((message) => {
            const textContent = message.role === 'user' ? message.BODY?.entry?.[0]?.messaging?.[0]?.message?.text ?? '(no text)' : message.BODY;
            console.log('textContent', textContent);
            console.log('entry', message.BODY?.entry);

            return ({
                role: message.role,
                content: `[Timestamp=${message.TIMESTAMP}]: ${textContent}`,
            });
        });
        console.log('[Ollama] Messages to send to Ollama contains', messages.length, 'messages');
        console.log('messages', messages);

        // Send to Ollama
        if (messages.length === 0) {
            console.log('[Ollama] No messages to send to Ollama');
        } else {
            const ollamaResponse = await ollama.chat({
                model: process.env.OLLAMA_MODEL,
                format: 'json',
                stream: false,
                keep_alive: '5m',
                messages: [messages[0]],
                think: false,
            });
            const ollamaDate = new Date();
            const responseContent = ollamaResponse.message?.content ?? '(no content)';
            console.log('[Ollama] Received Ollama Response of length', responseContent.length);
            console.log('[Ollama] Ollama Response: ', ollamaResponse.message);
            receivedUpdates.unshift({
                "TIME": ollamaDate,
                "TIMESTAMP": ollamaDate.valueOf(),
                "role": "assistant",
                "BODY": responseContent,
                "model": process.env.OLLAMA_MODEL,
            });

            // Send the response back to the user via Messenger Send API
            if (senderId) {
                const sendAPIResponse = await sendMessengerMessage(senderId, mid, responseContent);
                console.log('[Messenger] Send API response:', sendAPIResponse);
            } else {
                console.error('[Messenger] No sender ID found, cannot send reply');
            }
        }
    }

    await next();

    // Remove until the last object
    while (receivedUpdates.length > maxUpdates) {
        receivedUpdates.pop();
    }
});

app.use(router.routes()).use(router.allowedMethods());
app.listen(process.env.PORT ?? 5000);

console.log('Server Started');
