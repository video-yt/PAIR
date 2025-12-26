const { makeid } = require('./gen-id');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers
} = require("@whiskeysockets/baileys");

const { saveSession } = require('./githubSave')

function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}
router.get('/', async (req, res) => {
    const id = makeid();

    async function GIFTED_MD_PAIR_CODE() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);

        try {
            let sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Desktop"),
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // SEND QR
                if (qr) {
                    const qrImage = await QRCode.toBuffer(qr);
                    return res.end(qrImage);
                }

                // WHEN CONNECTED
                if (connection === "open") {
                    await delay(3000);

                    const credsPath = `./temp/${id}/creds.json`;

                    if (!fs.existsSync(credsPath)) return;
                    const credsBase64 = Buffer
                        .from(fs.readFileSync(credsPath))
                        .toString("base64")

                    // 🔥 SAVE TO GITHUB
                    await saveSession(sessionId, credsBase64)
let caption = "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved successfully!*\n*Bot will start automatically In 5 Minits*`"
                    await sock.sendMessage(
                        `${sock.user.id.split(":")[0]}@s.whatsapp.net`,
                        {
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
                        }
                    );

                    // CLEANUP
                    await delay(500);
                    await sock.ws.close();
                    removeFile('./temp/' + id);

                    console.log(`✔ ${userNumber} Connected — Session Saved: ${fileName}`);
                    process.exit(0);
                }

                // RETRY
                else if (connection === "close" &&
                    lastDisconnect?.error?.output?.statusCode !== 401) {
                    await delay(1500);
                    GIFTED_MD_PAIR_CODE();
                }
            });

        } catch (err) {
            console.log("Service restart:", err);
            removeFile('./temp/' + id);

            if (!res.headersSent) {
                res.send({ code: "❗ Service Unavailable" });
            }
        }
    }

    await GIFTED_MD_PAIR_CODE();
});

// AUTO RESTART
setInterval(() => {
    console.log("♻ Restarting process...");
    process.exit();
}, 180000);

module.exports = router;