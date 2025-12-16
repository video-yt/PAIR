const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const pino = require('pino');
const logger = pino({ level: 'info' });
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');

// =========================
// 👉 Add your Pastebin API key
// =========================
const PASTEBIN_KEY = "4t3wApHnExGBmHz7QyZt6UUALcAsTrCo";

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
}

function generateRandomText() {
    const prefix = "3EB";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let randomText = prefix;
    for (let i = prefix.length; i < 22; i++) {
        randomText += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return randomText;
}

async function GIFTED_MD_PAIR_CODE(id, num, res) {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'temp', id));
    const { version } = await fetchLatestBaileysVersion();

    try {
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            logger: logger,
            syncFullHistory: false,
            browser: Browsers.macOS('Safari'),
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            num = num.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(num);

            if (!res.headersSent) {
                res.send({ code });
            }
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                await delay(5000);
                const credsFilePath = path.join(__dirname, 'temp', id, 'creds.json');

                if (!fs.existsSync(credsFilePath)) return;

                const credsData = fs.readFileSync(credsFilePath, 'utf-8');

                // ================================
                // 🔥 Upload to Pastebin correctly
                // ================================
                let pasteId;
                try {
                    const form = new URLSearchParams();
                    form.append('api_dev_key', PASTEBIN_KEY);
                    form.append('api_option', 'paste');
                    form.append('api_paste_code', credsData);
                    form.append('api_paste_private', '0'); // unlisted
                    form.append('api_paste_format', 'text');

                    const pasteRes = await axios.post(
                        'https://pastebin.com/api/api_post.php',
                        form.toString(),
                        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
                    );

                    pasteId = pasteRes.data.split('/').pop();

                } catch (err) {
                    logger.error(`Pastebin Upload Error: ${err.response?.data || err.message}`);
                    await sock.sendMessage(`${sock.user.id.split(":")[0]}@s.whatsapp.net`, { text: '❌ Pastebin upload failed!' });
                    return;
                }

                // ================================
                // 🔥 Send session ID to user
                // ================================
                const msg = await sock.sendMessage(`${sock.user.id.split(":")[0]}@s.whatsapp.net`, {
                    text: `*YOUR SESSION ID*\n\n\`\`\`XPRO~${pasteId}\`\`\`\n\n⚠️ Keep it private!`
                });

                const caption = `
🔐 *DO NOT SHARE THIS SESSION ID!!*

Use this *SESSION_ID* to run your *XPROVerce MD* Bot. 🤖

\`\`\`js
module.exports = {
  SESSION_ID: 'XPRO~${pasteId}'
}
\`\`\`

⚠️ Keep your session ID safe!
`;

                await sock.sendMessage(`${sock.user.id.split(":")[0]}@s.whatsapp.net`, {
                    text: caption,
                    contextInfo: {
                        externalAdReply: {
                            title: "XPROVerce MD",
                            thumbnailUrl: "https://i.ibb.co/VWy8DK06/Whats-App-Image-2025-12-09-at-17-38-33-fd4d4ecd.jpg",
                            sourceUrl: "https://whatsapp.com/channel/0029VbBbldUJ93wbCIopwf2m",
                            mediaType: 2,
                            renderLargerThumbnail: true,
                            showAdAttribution: true,
                        },
                    },
                }, { quoted: msg });

                // Cleanup
                await delay(500);
                await sock.ws.close();
                removeFile(path.join(__dirname, 'temp', id));

                logger.info(`Session uploaded to Pastebin: ${pasteId}`);
                process.exit(0);
            }

            // Reconnect if needed
            else if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
                logger.warn('Connection closed. Retrying...');
                await delay(10000);
                GIFTED_MD_PAIR_CODE(id, num, res);
            }
        });

    } catch (error) {
        logger.error(`Error in GIFTED_MD_PAIR_CODE: ${error.message}`);
        removeFile(path.join(__dirname, 'temp', id));

        if (!res.headersSent) {
            res.send({ code: '❗ Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const id = makeid();
    const num = req.query.number;

    if (!num) return res.status(400).send({ error: 'Number is required' });

    await GIFTED_MD_PAIR_CODE(id, num, res);
});

// Auto restart
setInterval(() => {
    logger.info('♻️ Restarting process...');
    process.exit(0);
}, 1800000);

module.exports = router;
