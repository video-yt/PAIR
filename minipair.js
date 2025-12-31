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

// Import the database module
const KoyebDB = require('./koyebDB'); 

function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}

async function GIFTED_MD_PAIR_CODE(id, num, res) {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'temp', id));
    const { version } = await fetchLatestBaileysVersion();

    // Track if session has been saved to prevent reconnection attempts
    let sessionSaved = false;
    // Track if we've already sent a response
    let responseSent = false;

    try {
        // Initialize DB connection if not already connected
        if (!KoyebDB.connected) await KoyebDB.initialize();

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

            if (!responseSent) {
                responseSent = true;
                if (!res.headersSent) {
                    res.send({ code });
                }
            }
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                await delay(5000);
                
                // If session already saved, don't save again
                if (sessionSaved) return;
                
                const credsFilePath = path.join(__dirname, 'temp', id, 'creds.json');

                if (!fs.existsSync(credsFilePath)) return;

                const credsBase64 = Buffer
                    .from(fs.readFileSync(credsFilePath))
                    .toString("base64")
                
                // 🔥 SAVE TO POSTGRESQL (KoyebDB)
                // We use the phone number (num) or the unique id as the session_id
                await KoyebDB.saveSession(num, credsBase64, true);
                
                // Mark session as saved
                sessionSaved = true;
                
                let caption = "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved to Database!*\n*Bot will start automatically on the main server.*`"
                
                await sock.sendMessage(
                    `${sock.user.id.split(":")[0]}@s.whatsapp.net`, {
                    text: caption,
                    contextInfo: {
                        externalAdReply: {
                            title: "XPROVerce MD - Session",
                            thumbnailUrl: "https://i.ibb.co/VWy8DK06/Whats-App-Image-2025-12-09-at-17-38-33-fd4d4ecd.jpg",
                            sourceUrl: "https://whatsapp.com/channel/0029VbBbldUJ93wbCIopwf2m",
                            mediaType: 2,
                            renderLargerThumbnail: true,
                            showAdAttribution: true,
                        },
                    },
                });

                await delay(500);
                await sock.ws.close();
                removeFile(path.join(__dirname, 'temp', id));

                logger.info(`Session ${num} saved to KoyebDB.`);
                // Note: Don't process.exit(0) if this is an Express server handling multiple users
            }
            else if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
                // Only attempt to reconnect if session hasn't been saved yet
                if (!sessionSaved) {
                    await delay(10000);
                    logger.info(`Attempting to reconnect for ${num}...`);
                    GIFTED_MD_PAIR_CODE(id, num, res);
                } else {
                    logger.info(`Session ${num} already saved, not reconnecting.`);
                }
            }
        });

    } catch (error) {
        logger.error(`Error: ${error.message}`);
        removeFile(path.join(__dirname, 'temp', id));
        if (!responseSent && !res.headersSent) {
            responseSent = true;
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

module.exports = router;
