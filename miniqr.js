const { makeid } = require('./gen-id');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
let router = express.Router();
const pino = require("pino");
const DatabaseHelper = require('./databaseHelper');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers
} = require("@whiskeysockets/baileys");

function removeFile(path) {
  if (fs.existsSync(path)) fs.rmSync(path, { recursive: true, force: true })
}

// Track active pairing sessions to prevent duplicates
const activePairingSessions = new Map();

router.get('/', async (req, res) => {
    const id = makeid();
    
    // Add timeout for response
    res.setTimeout(120000, () => {
      if (!res.headersSent) {
        cleanupSession(id);
        res.status(408).json({ 
          status: false, 
          message: 'Pairing timeout. Please try again.' 
        });
      }
    });

    async function GIFTED_MD_PAIR_CODE() {
        const authPath = './temp/' + id;
        
        // Check if session already exists in database
        try {
          const sessionCheck = await DatabaseHelper.verifySession(id);
          if (sessionCheck.exists && sessionCheck.hasCredentials) {
            console.log(`⚠️ Session ${id} already exists with valid credentials`);
            if (!res.headersSent) {
              return res.status(400).json({ 
                status: false, 
                message: 'Session already exists' 
              });
            }
          }
        } catch (error) {
          console.error('Session verification failed:', error.message);
        }

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

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
                    try {
                        const qrImage = await QRCode.toBuffer(qr);
                        
                        // Set proper content type for image
                        res.setHeader('Content-Type', 'image/png');
                        return res.end(qrImage);
                    } catch (qrError) {
                        console.error('QR generation error:', qrError);
                        if (!res.headersSent) {
                            return res.status(500).json({ 
                                status: false, 
                                message: 'Failed to generate QR code' 
                            });
                        }
                    }
                }

                // WHEN CONNECTED
                if (connection === "open") {
                    await delay(5000); // Increased delay for more reliable credential saving

                    const credsPath = `${authPath}/creds.json`;

                    if (!fs.existsSync(credsPath)) {
                        console.log(`❌ Credentials file not found for ${id}`);
                        await sendErrorMessage(sock, 'Failed to save credentials: File not found');
                        cleanupSession(id);
                        return;
                    }

                    try {
                        const credsContent = fs.readFileSync(credsPath, 'utf8');
                        
                        // Validate JSON before converting to base64
                        const parsedCreds = JSON.parse(credsContent);
                        if (!parsedCreds || Object.keys(parsedCreds).length === 0) {
                            throw new Error('Empty credentials JSON');
                        }
                        
                        const credsBase64 = Buffer.from(credsContent).toString("base64");
                        
                        // Validate base64 string
                        if (!credsBase64 || credsBase64.trim() === '') {
                            throw new Error('Generated empty base64 string');
                        }

                        // 🔥 SAVE TO DATABASE
                        try {
                            await DatabaseHelper.saveSessionToDB(id, credsBase64);
                            
                            // Send success message
                            await sendSuccessMessage(sock);
                            
                            console.log(`✅ Session saved to database: ${id}`);
                            
                        } catch (dbError) {
                            console.error(`❌ Database save failed for ${id}:`, dbError.message);
                            await sendErrorMessage(sock, `Failed to save to database: ${dbError.message}`);
                        }

                    } catch (credError) {
                        console.error(`❌ Credentials processing error for ${id}:`, credError.message);
                        await sendErrorMessage(sock, 'Failed to process credentials');
                    }

                    // CLEANUP
                    await delay(1000);
                    try {
                        await sock.ws.close();
                    } catch (closeError) {
                        console.error('Socket close error:', closeError.message);
                    }
                    removeFile(authPath);
                    activePairingSessions.delete(id);
                }

                // RETRY
                else if (connection === "close" &&
                    lastDisconnect?.error?.output?.statusCode !== 401) {
                    console.log(`⚠️ Connection closed for ${id}, retrying...`);
                    await delay(3000);
                    cleanupSession(id);
                    GIFTED_MD_PAIR_CODE();
                }
            });

        } catch (err) {
            console.log("Service error:", err.message);
            cleanupSession(id);
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    status: false, 
                    message: "Service Unavailable",
                    error: err.message 
                });
            }
        }
    }

    // Store session in active tracking
    activePairingSessions.set(id, {
        createdAt: Date.now(),
        status: 'pairing'
    });
    
    // Cleanup old sessions periodically
    cleanupOldSessions();
    
    await GIFTED_MD_PAIR_CODE();
});

async function sendSuccessMessage(sock) {
    try {
        const caption = "`> [ X P R O V E R C E   M I N I ]\n*✅ Session saved successfully!*\n*Bot will start automatically In 5 Minutes*`"
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
    } catch (msgError) {
        console.error('Failed to send success message:', msgError.message);
    }
}

async function sendErrorMessage(sock, errorMessage) {
    try {
        const caption = `\`> [ X P R O V E R C E   M I N I ]\n*❌ Session Save Failed!*\n*Error: ${errorMessage}*\n*Please try again*\``;
        await sock.sendMessage(
            `${sock.user.id.split(":")[0]}@s.whatsapp.net`,
            { text: caption }
        );
    } catch (msgError) {
        console.error('Failed to send error message:', msgError.message);
    }
}

function cleanupSession(id) {
    const authPath = `./temp/${id}`;
    removeFile(authPath);
    activePairingSessions.delete(id);
    console.log(`🧹 Cleaned up session: ${id}`);
}

function cleanupOldSessions() {
    const now = Date.now();
    const MAX_AGE = 10 * 60 * 1000; // 10 minutes
    
    for (const [id, session] of activePairingSessions.entries()) {
        if (now - session.createdAt > MAX_AGE) {
            console.log(`🕒 Removing old session: ${id}`);
            cleanupSession(id);
        }
    }
}

module.exports = router;
