const Koa = require('koa');
const Router = require('@koa/router');
const koaBody = require('koa-body');
const crypto = require('crypto')

const app = new Koa({ proxy: true });
const router = new Router();

// Keep a maximum here so we don't use up all the memory
const maxUpdates = 100;
var receivedUpdates = [];
var lastUpdated = Date.now();

// Uncomment if you wish to validate Event Notifications, and add as a middleware *before* koaBody() in the POST webhooks route
// i.e. `router.post('/webhooks', validateXHub, koaBody(), async (ctx, next) => {`
// Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
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
    ctx.body = `<h3>Total Updates: ${receivedUpdates.length}&nbsp;<small>Caching only ${maxUpdates} updates</small></h3><pre>${JSON.stringify(receivedUpdates, null, 2)}</pre>`;
});

// The webhook registration page
router.get('/webhooks', (ctx) => {
    // Processed according to https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
    const queryParams = ctx.request.query;
    if (queryParams['hub.mode'] != 'subscribe' || queryParams['hub.verify_token'] != process.env.VERIFY_TOKEN) {
        ctx.status = 401;
        ctx.body = 'hub.mode is not `subscribe`, or hub.verify_token does not match the provided environment\'s value';
    } else {
        ctx.body = queryParams['hub.challenge'];
    }
});

// Parsing incoming webhooks, which relies on koaBody to parse JSON
router.post('/webhooks', koaBody(), async (ctx, next) => {
    console.log(`Received webhook data: `, ctx.request.body);
    receivedUpdates.unshift(ctx.request.body);
    // Remove until the last object
    while (receivedUpdates.length > maxUpdates) {
        receivedUpdates.pop();
    }
    ctx.status = 200;
    ctx.body = 'Received';

    await next();
});

app.use(router.routes()).use(router.allowedMethods());
app.listen(5000);