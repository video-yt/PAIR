const express = require("express");
const fs = require("fs");
const pino = require("pino");
const { makeid } = require("./gen-id");
const DatabaseHelper = require("./databaseHelper");

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

// Track active pairing sessions
const activePairingSessions = new Map();

router.post("/", async (req, res) => {
  const id = makeid();
  const authPath = `./temp/${id}`;
  const { phone } = req.body || {};

  if (!phone) {
    return res.status(400).json({ status: false, message: "Phone required" });
  }

  // Validate phone number format
  const phoneRegex = /^\d{10,15}$/;
  if (!phoneRegex.test(phone.replace(/\D/g, ''))) {
    return res.status(400).json({ 
      status: false, 
      message: "Invalid phone number format" 
    });
  }

  // Set response timeout
  res.setTimeout(90000, () => {
    if (!res.headersSent) {
      cleanupSession(id);
      res.status(408).json({ 
        status: false, 
        message: 'Pairing timeout. Please try again.' 
      });
    }
  });

  try {
    // Check if session already exists
    const sessionCheck = await DatabaseHelper.verifySession(id);
    if (sessionCheck.exists && sessionCheck.hasCredentials) {
      console.log(`⚠️ Session ${id} already exists with valid credentials`);
      return res.status(400).json({ 
        status: false, 
        message: 'Session already exists' 
      });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("MiniPair"),
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    let responded = false;
    let pairingCompleted = false;

    sock.ev.on("connection.update", async ({ connection }) => {
      if (connection === "open") {
        if (pairingCompleted) return; // Prevent multiple triggers
        
        pairingCompleted = true;
        await delay(3000); // Wait for credentials to be fully saved

        const credsPath = `${authPath}/creds.json`;
        if (!fs.existsSync(credsPath)) {
          console.log(`❌ Credentials file not found for ${id}`);
          cleanupSession(id);
          return;
        }

        try {
          // Read and validate credentials
          const credsContent = fs.readFileSync(credsPath, 'utf8');
          const parsedCreds = JSON.parse(credsContent);
          
          if (!parsedCreds || Object.keys(parsedCreds).length === 0) {
            throw new Error('Empty credentials JSON');
          }
          
          const credsBase64 = Buffer.from(credsContent).toString("base64");
          
          if (!credsBase64 || credsBase64.trim() === '') {
            throw new Error('Generated empty base64 string');
          }

          // 🔥 SAVE TO DATABASE
          await DatabaseHelper.saveSessionToDB(id, credsBase64);

          // Send success message
          await sock.sendMessage(
            `${sock.user.id.split(":")[0]}@s.whatsapp.net`,
            {
              text: "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved successfully!*\n*Bot will start automatically In 5 Minutes*`"
            }
          );

          console.log(`✅ Pairing session saved to database: ${id}`);

        } catch (credError) {
          console.error(`❌ Credentials error for ${id}:`, credError.message);
          // Don't send error message to user to avoid confusion
        }

        // Cleanup
        await delay(1000);
        try {
          await sock.ws.close();
        } catch (closeError) {
          console.error('Socket close error:', closeError.message);
        }
        removeFile(authPath);
        activePairingSessions.delete(id);
      }
    });

    const code = await sock.requestPairingCode(phone);

    // Store session in tracking
    activePairingSessions.set(id, {
      createdAt: Date.now(),
      phone: phone,
      status: 'pairing'
    });

    responded = true;
    return res.json({
      status: true,
      sessionId: id,
      code: code,
      message: "Use this code to pair your device"
    });

  } catch (err) {
    console.error(`❌ Pairing error for ${id}:`, err.message);
    cleanupSession(id);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        status: false, 
        message: err.message.includes('timeout') ? 'Pairing timeout. Please try again.' : err.message 
      });
    }
  }
});

function cleanupSession(id) {
  const authPath = `./temp/${id}`;
  removeFile(authPath);
  activePairingSessions.delete(id);
  console.log(`🧹 Cleaned up pairing session: ${id}`);
}

// Periodic cleanup of old sessions
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 15 * 60 * 1000; // 15 minutes
  
  for (const [id, session] of activePairingSessions.entries()) {
    if (now - session.createdAt > MAX_AGE) {
      console.log(`🕒 Removing old pairing session: ${id}`);
      cleanupSession(id);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

module.exports = router;
