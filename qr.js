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

const axios = require('axios');

// ===============================
// 🔥 ADD YOUR PASTEBIN KEY
// ===============================
const PASTEBIN_KEY = "4t3wApHnExGBmHz7QyZt6UUALcAsTrCo";

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
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

                    const sessionData = fs.readFileSync(credsPath, "utf8");

                    // =====================================
                    // 🔥 FIXED — CORRECT PASTEBIN REQUEST
                    // =====================================
                    const form = new URLSearchParams();
                    form.append("api_dev_key", PASTEBIN_KEY);
                    form.append("api_option", "paste");
                    form.append("api_paste_code", sessionData);
                    form.append("api_paste_private", "0"); // unlisted
                    form.append("api_paste_format", "json");

                    let pasteUrl;

                    try {
                        const response = await axios.post(
                            "https://pastebin.com/api/api_post.php",
                            form.toString(),
                            {
                                headers: {
                                    "Content-Type": "application/x-www-form-urlencoded"
                                }
                            }
                        );

                        pasteUrl = response.data;
                        console.log(response) // example: https://pastebin.com/Abcde123
                    } catch (err) {
                        console.log(err.response?.data || err.message);
                        await sock.sendMessage(`${sock.user.id.split(":")[0]}@s.whatsapp.net`, { text: "❗ Pastebin upload failed!" });
                        return;
                    }

                    const pasteId = pasteUrl.split("/").pop();

                    // SEND SESSION ID TO USER
                    const msg = await sock.sendMessage(`${sock.user.id.split(":")[0]}@s.whatsapp.net`, {
                        text: `*YOUR SESSION ID*\n\n\`\`\`XPRO~${pasteId}\`\`\`\n\n⚠️ Keep it private!`
                    });

                    const caption = `
🔐 *NEVER SHARE THIS SESSION ID!*

Use this *SESSION_ID* to run your *XPROVerce MD BOT*.

\`\`\`js
module.exports = {
  SESSION_ID: 'XPRO~${pasteId}'
}
\`\`\`

⚠️ Treat this like a password!
`;

                    await sock.sendMessage(
                        `${sock.user.id.split(":")[0]}@s.whatsapp.net`,
                        {
                            text: caption,
                            contextInfo: {
                                externalAdReply: {
                                    title: "XPROVerce MD",
                                    thumbnailUrl: "https://i.ibb.co/VWy8DK06/Whats-App-Image-2025-12-09-at-17-38-33-fd4d4ecd.jpg",
                                    sourceUrl: "https://whatsapp.com/channel/0029VbBbldUJ93wbCIopwf2m",
                                    mediaType: 2,
                                    renderLargerThumbnail: true,
                                    showAdAttribution: true
                                }
                            }
                        },
                        { quoted: msg }
                    );

                    // CLEANUP
                    await delay(500);
                    await sock.ws.close();
                    removeFile('./temp/' + id);

                    console.log(`✔ ${sock.user.id} Connected — Session Saved: ${pasteId}`);
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
