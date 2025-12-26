const express = require("express");
const fs = require("fs");
const pino = require("pino");
const QRCode = require("qrcode");
const { makeid } = require("./gen-id");
const { saveSession } = require("./githubSave");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers
} = require("@whiskeysockets/baileys");

const router = express.Router();

function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true });
}

router.post("/", async (req, res) => {
  const id = makeid();
  const authPath = `./temp/${id}`;
  const { phone } = req.body || {};

  if (!phone) {
    return res.status(400).json({ status: false, message: "Phone required" });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("MiniPair"),
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    let responded = false;

    sock.ev.on("connection.update", async ({ connection }) => {

      if (connection === "open") {
        await delay(2000);

        const credsPath = `${authPath}/creds.json`;
        if (!fs.existsSync(credsPath)) return;

        const credsBase64 = Buffer
          .from(fs.readFileSync(credsPath))
          .toString("base64");

        await saveSession(id, credsBase64);

        // 🔥 MESSAGE AFTER CONNECTION (KEPT AS REQUESTED)
        await sock.sendMessage(
          `${sock.user.id.split(":")[0]}@s.whatsapp.net`,
          {
            text: "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved successfully!*\n*Bot will start automatically In 5 Minutes*`"
          }
        );

        await delay(1000);
        await sock.ws.close();
        removeFile(authPath);
      }
    });

    const code = await sock.requestPairingCode(phone);

    responded = true;
    return res.json({
      status: true,
      sessionId: id,
      code
    });

  } catch (err) {
    removeFile(authPath);
    if (!res.headersSent) {
      res.status(500).json({ 
        status: false, 
        message: err.message 
      });
    }
  }
});

module.exports = router;
