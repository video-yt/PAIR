const { makeid } = require('./gen-id');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const router = express.Router();
const pino = require("pino");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers
} = require("@whiskeysockets/baileys");

// Import the database module
const KoyebDB = require('./koyebDB');

function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}

router.get('/', async (req, res) => {
    const id = makeid();

    async function GIFTED_MD_QR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);

        try {
            // Initialize DB connection
            if (!KoyebDB.connected) await KoyebDB.initialize();

            let sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Desktop"),
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    const qrImage = await QRCode.toBuffer(qr);
                    res.type('image/png');
                    return res.send(qrImage);
                }

                if (connection === "open") {
                    await delay(3000);
                    const credsPath = `./temp/${id}/creds.json`;

                    if (!fs.existsSync(credsPath)) return;
                    const credsBase64 = Buffer
                        .from(fs.readFileSync(credsPath))
                        .toString("base64")

                    // 🔥 SAVE TO POSTGRESQL (KoyebDB)
                    const userNumber = sock.user.id.split(":")[0];
                    await KoyebDB.saveSession(userNumber, credsBase64, true);

                    let caption = "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved successfully!*\n*The bot will start on the main server shortly.*`"
                    
                    await sock.sendMessage(`${userNumber}@s.whatsapp.net`, {
                        text: caption,
                        contextInfo: {
                            externalAdReply: {
                                title: "XPROVerce MD - Session",
                                thumbnailUrl: "https://i.ibb.co/VWy8DK06/Whats-App-Image-2025-12-09-at-17-38-33-fd4d4ecd.jpg",
                                sourceUrl: "https://whatsapp.com/channel/0029VbBbldUJ93wbCIopwf2m",
                                mediaType: 2,
                                renderLargerThumbnail: true,
                                showAdAttribution: true
                            }
                        }
                    });

                    await delay(500);
                    await sock.ws.close();
                    removeFile('./temp/' + id);
                    console.log(`✔ ${userNumber} Connected — Session Saved to DB`);
                }
                else if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
                    await delay(1500);
                    GIFTED_MD_QR_CODE();
                }
            });

        } catch (err) {
            console.log("Service error:", err);
            removeFile('./temp/' + id);
            if (!res.headersSent) res.send({ code: "❗ Service Unavailable" });
        }
    }

    await GIFTED_MD_QR_CODE();
});

module.exports = router;