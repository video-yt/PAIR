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
const { Octokit } = require("@octokit/rest");

// =========================
// 🔥 GITHUB CONFIGURATION
// =========================
const GITHUB_TOKEN = "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";
const REPO_OWNER = "video-yt";
const REPO_NAME = "Xpro-Mini-DB";
const FILE_PATH = "Main_BOT_sessions/"; // Folder in your repo

// Initialize Octokit
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store mapping for quick lookups
const keyToNumberMap = new Map();

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
}

function generateSessionKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
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

        // Generate pairing code for the provided number
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
                
                // ================================
                // 🔥 Upload to GitHub instead of Pastebin
                // ================================
                const uploadResult = await uploadToGitHub(fileName, credsData, userNumber);
                
                if (!uploadResult.success) {
                    logger.error(`GitHub Upload Error: ${uploadResult.error}`);
                    await sock.sendMessage(`${userNumber}@s.whatsapp.net`, { 
                        text: '❌ Failed to save session to GitHub!' 
                    });
                    return;
                }

                // ================================
                // 🔥 Send session KEY to user (not Pastebin ID)
                // ================================
                const fullKey = `XPROVerce~${sessionKey}`;
                const msg = await sock.sendMessage(`${userNumber}@s.whatsapp.net`, {
                    text: `*YOUR SESSION KEY*\n\n\`\`\`${fullKey}\`\`\`\n\n⚠️ Keep it private!`
                });

                const caption = `
🔐 *NEVER SHARE THIS SESSION KEY!*

Use this *SESSION KEY* to run your *XPROVerce MD* Bot:

\`\`\`js
module.exports = {
  SESSION_KEY: '${fullKey}'
}
\`\`\`
*How to use:*
1. Save this key: \`${fullKey}\`
2. Your bot only needs this key to download session
3. Session will auto-update when you reconnect
`;

                await sock.sendMessage(`${userNumber}@s.whatsapp.net`, {
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
                }, { quoted: msg });

                // Cleanup
                await delay(500);
                await sock.ws.close();
                removeFile(path.join(__dirname, 'temp', id));

                logger.info(`Session saved to GitHub: ${fileName} (Key: ${fullKey})`);
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

// ===================================
// 🔥 ADDITIONAL ENDPOINTS FOR SESSION MANAGEMENT
// ===================================

// Download endpoint using only key
router.get('/download/:key', async (req, res) => {
    try {
        let key = req.params.key;
        
        // Handle XPROVerce~key format
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        // Find the file by searching all files
        const files = await listSessionFiles();
        let fileInfo = null;
        
        for (const file of files) {
            const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
            if (match && match[1] === key) {
                fileInfo = {
                    fileName: file,
                    key: match[1],
                    number: match[2]
                };
                break;
            }
        }
        
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
router.get('/bot-download', async (req, res) => {
    try {
        let { key } = req.query;
        
        if (!key) {
            return res.status(400).json({
                success: false,
                error: "Key is required"
            });
        }
        
        // Handle XPROVerce~key format
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        // Find the file
        const files = await listSessionFiles();
        let fileInfo = null;
        
        for (const file of files) {
            const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
            if (match && match[1] === key) {
                fileInfo = {
                    fileName: file,
                    key: match[1],
                    number: match[2]
                };
                break;
            }
        }
        
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
        
        // Decode base64 content and return raw
        const content = Buffer.from(response.data.content, 'base64').toString();
        
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
});

// Verify key exists
router.get('/verify/:key', async (req, res) => {
    try {
        let key = req.params.key;
        
        if (key.startsWith('XPROVerce~')) {
            key = key.replace('XPROVerce~', '');
        }
        
        const files = await listSessionFiles();
        let fileInfo = null;
        
        for (const file of files) {
            const match = file.match(/^XPROVerce~([a-zA-Z0-9]+)-(\d+)\.json$/);
            if (match && match[1] === key) {
                fileInfo = {
                    fileName: file,
                    key: match[1],
                    number: match[2]
                };
                break;
            }
        }
        
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

// Auto restart
setInterval(() => {
    logger.info('♻️ Restarting process...');
    process.exit(0);
}, 1800000);

module.exports = router;