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
const { Octokit } = require("@octokit/rest");

// ===============================
// 🔥 GITHUB CONFIGURATION
// ===============================
const abcd = "3fmykHwVcAsMFNo5HKHJGzBvIShF4k42qUpI";
const GITHUB_TOKEN = `ghp_${abcd}`;
const REPO_OWNER = "video-yt";
const REPO_NAME = "Xpro-Mini-DB";
const FILE_PATH = "Main_BOT_sessions/"; // Folder in your repo

// Initialize Octokit
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store mapping for quick lookups (in production, use database)
const keyToNumberMap = new Map();

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

// Helper function to list all session files
async function listSessionFiles() {
    try {
        const { data } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: FILE_PATH
        });
        
        return data.filter(file => file.name.endsWith('.json'))
                   .map(file => file.name);
    } catch (error) {
        console.error('Error listing files:', error);
        return [];
    }
}

// Helper function to find file by key
async function findFileByKey(key) {
    const files = await listSessionFiles();
    
    for (const file of files) {
        // Extract key from filename (format: XPROVerce~abc123def-1234567890.json)
        const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
        if (match && match[1] === key) {
            return {
                fileName: file,
                key: match[1],
                number: match[2]
            };
        }
    }
    return null;
}

// Helper function to check if file exists
async function checkFileExists(fileName) {
    try {
        await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: `${FILE_PATH}${fileName}`
        });
        return true;
    } catch (error) {
        if (error.status === 404) return false;
        throw error;
    }
}

// Helper function to get SHA of existing file
async function getFileSha(fileName) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: `${FILE_PATH}${fileName}`
        });
        return data.sha;
    } catch (error) {
        return null;
    }
}

// Helper function to upload/update file in GitHub
async function uploadToGitHub(fileName, content, userNumber) {
    try {
        const fileExists = await checkFileExists(fileName);
        const sha = await getFileSha(fileName);
        
        const response = await octokit.repos.createOrUpdateFileContents({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: `${FILE_PATH}${fileName}`,
            message: userNumber ? 
                `Updated session for ${userNumber}` : 
                `Created session ${fileName}`,
            content: Buffer.from(content).toString('base64'),
            sha: sha || undefined
        });
        
        return {
            success: true,
            downloadUrl: response.data.content.download_url,
            fileName: fileName
        };
    } catch (error) {
        console.error('GitHub upload error:', error);
        return { success: false, error: error.message };
    }
}

// Generate unique key for new sessions
function generateSessionKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
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
                    const userNumber = sock.user.id.split(":")[0];
                    
                    let sessionKey;
                    let fileName;
                    
                    // Check if user already has a session key
                    const existingFile = await findFileByUserNumber(userNumber);
                    
                    if (existingFile) {
                        // Use existing key
                        sessionKey = existingFile.key;
                        fileName = `XPROVerce~${sessionKey}-${userNumber}.json`;
                    } else {
                        // Generate new key
                        sessionKey = generateSessionKey();
                        fileName = `XPROVerce~${sessionKey}-${userNumber}.json`;
                        // Store in memory map
                        keyToNumberMap.set(sessionKey, userNumber);
                    }
                    
                    // Upload to GitHub
                    const uploadResult = await uploadToGitHub(fileName, sessionData, userNumber);
                    
                    if (!uploadResult.success) {
                        await sock.sendMessage(`${userNumber}@s.whatsapp.net`, { 
                            text: "❗ Failed to save session to GitHub!" 
                        });
                        return;
                    }

                    // SEND SESSION INFO TO USER with XPROVerce~key format
                    const fullKey = `XPROVerce~${sessionKey}`;
                    const msg = await sock.sendMessage(`${userNumber}@s.whatsapp.net`, {
                        text: `*YOUR SESSION INFO*\n\n` +
                              `🔑 *Session Key:* \`${fullKey}\`\n` +
                              `📱 *Your Number:* \`${userNumber}\`\n\n` +
                              `⚠️ *IMPORTANT:* Save this key! You only need this key to download your session later.`
                    });

                    const caption = `
🔐 *NEVER SHARE YOUR SESSION KEY!*

Use this *SESSION KEY* to run your bot:

\`\`\`js
module.exports = {
  SESSION_KEY: '${fullKey}'
}
\`\`\`
*Usage Instructions:*
1. Keep this key safe
2. Use only \`${fullKey}\` to download your session
3. Your bot will auto-update on reconnect
`;

                    await sock.sendMessage(
                        `${userNumber}@s.whatsapp.net`,
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
                        },
                        { quoted: msg }
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

// Helper function to find file by user number
async function findFileByUserNumber(number) {
    const files = await listSessionFiles();
    
    for (const file of files) {
        // Extract number from filename (format: XPROVerce~key-number.json)
        const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
        if (match && match[2] === number) {
            return {
                fileName: file,
                key: match[1],
                number: match[2]
            };
        }
    }
    return null;
}

// Download endpoint using only key (supports both formats)
router.get('/download/:key', async (req, res) => {
    try {
        let key = req.params.key;
        
        // Handle both XPROVerce~key and key-only formats
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        const fileInfo = await findFileByKey(key);
        
        if (!fileInfo) {
            return res.status(404).json({
                success: false,
                error: "Session not found"
            });
        }
        
        const response = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: `${FILE_PATH}${fileInfo.fileName}`
        });
        
        // Decode base64 content
        const content = Buffer.from(response.data.content, 'base64').toString();
        
        res.json({
            success: true,
            key: `XPROVerce~${fileInfo.key}`,
            number: fileInfo.number,
            fileName: fileInfo.fileName,
            session: JSON.parse(content)
        });
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// Bot download endpoint (for bot to retrieve session using only key)
async function botdl(req,res) {
    try {
        let { key } = req.query;
        
        if (!key) {
            return res.status(400).json({
                success: false,
                error: "Key is required"
            });
        }
        
        // Handle both XPROVerce~key and key-only formats
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        const fileInfo = await findFileByKey(key);
        
        if (!fileInfo) {
            return res.status(404).json({
                success: false,
                error: "Session not found"
            });
        }
        
        const response = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: `${FILE_PATH}${fileInfo.fileName}`
        });
        
        // Decode base64 content
        const content = Buffer.from(response.data.content, 'base64').toString();
        
        // Return raw JSON content
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.fileName}"`);
        res.send(content);
        
    } catch (error) {
        console.error('Bot download error:', error);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
}

// Simple endpoint to verify key exists
router.get('/verify/:key', async (req, res) => {
    try {
        let key = req.params.key;
        
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        const fileInfo = await findFileByKey(key);
        
        if (fileInfo) {
            res.json({
                success: true,
                exists: true,
                key: `XPROVerce~${fileInfo.key}`,
                number: fileInfo.number,
                message: "Session found"
            });
        } else {
            res.json({
                success: true,
                exists: false,
                message: "Session not found"
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

// List all sessions (for admin purposes)
router.get('/list-sessions', async (req, res) => {
    try {
        const files = await listSessionFiles();
        const sessions = [];
        
        for (const file of files) {
            const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
            if (match) {
                sessions.push({
                    fileName: file,
                    key: `XPROVerce~${match[1]}`,
                    number: match[2],
                    rawKey: match[1]
                });
            }
        }
        
        res.json({
            success: true,
            count: sessions.length,
            sessions: sessions
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});


module.exports = router;
module.exports.botdl = botdl;
