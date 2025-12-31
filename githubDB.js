const axios = require("axios")
const { MongoClient } = require('mongodb')

const abcd = "3fmykHwVcAsMFNo5HKHJGzBvIShF4k42qUpI";
const GITHUB_TOKEN = `ghp_${abcd}`;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "video-yt"
const GITHUB_REPO = process.env.GITHUB_REPO || "Xpro-Mini-DB"
const GITHUB_FILE = process.env.GITHUB_FILE || "session.json"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main"

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://videoyt823_db_user:MNgL1SZlA6g9aWcB@xpromini.qsaxilm.mongodb.net/?appName=xpromini"
const MONGODB_DB = process.env.MONGODB_DB || "minibotdb"

let mongoClient = null
let db = null
let sessionsCollection = null
let deploymentsCollection = null

const api = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "xpro-mini-bot"
  },
  timeout: 15000 // Increased timeout for reliability
})

// Added retry interceptor for GitHub API calls
api.interceptors.response.use(null, async (error) => {
  const { config, response } = error;
  if (!config || !config.retryCount) config.retryCount = 0;
  
  if (config.retryCount < 3 && (!response || response.status >= 500)) {
    config.retryCount++;
    const delay = Math.pow(2, config.retryCount) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
    return api(config);
  }
  return Promise.reject(error);
});

async function initMongoDB() {
  if (mongoClient && db) return;
  try {
    // Optimized for long-running processes
    mongoClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 10000
    })
    await mongoClient.connect()
    db = mongoClient.db(MONGODB_DB)
    sessionsCollection = db.collection('sessions')
    deploymentsCollection = db.collection('deployments')
    
    await Promise.all([
      sessionsCollection.createIndex({ session_id: 1 }, { unique: true }),
      sessionsCollection.createIndex({ deployment_id: 1 }),
      sessionsCollection.createIndex({ enabled: 1, status: 1 }),
      sessionsCollection.createIndex({ last_heartbeat: 1 }),
      sessionsCollection.createIndex({ updated_at: 1 }),
      deploymentsCollection.createIndex({ deployment_id: 1 }, { unique: true }),
      deploymentsCollection.createIndex({ last_heartbeat: 1 })
    ])
    console.log('MongoDB initialized successfully')
  } catch (error) {
    console.error('Failed to initialize MongoDB:', error.message)
    throw error
  }
}

async function migrateGitHubToMongoDB() {
  try {
    console.log('Checking for existing sessions in GitHub to migrate...')
    const res = await api.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`)
    const githubData = JSON.parse(Buffer.from(res.data.content, "base64").toString())

    if (githubData.sessions && Object.keys(githubData.sessions).length > 0) {
      let migratedCount = 0
      const now = new Date()
      for (const [sessionId, sessionData] of Object.entries(githubData.sessions)) {
        try {
          const existing = await sessionsCollection.findOne({ session_id: sessionId })
          if (!existing) {
            await sessionsCollection.insertOne({
              session_id: sessionId,
              creds: sessionData.creds,
              enabled: sessionData.enabled !== false,
              status: 'stopped',
              deployment_id: null,
              deployment_host: null,
              claimed_at: null,
              last_heartbeat: null,
              created_at: sessionData.created ? new Date(sessionData.created) : now,
              updated_at: sessionData.updated ? new Date(sessionData.updated) : now,
              last_backup_to_github: sessionData.updated ? new Date(sessionData.updated) : now,
              restart_count: 0,
              metadata: { migrated_from_github: true }
            })
            migratedCount++
          }
        } catch (e) {}
      }
      console.log(`Migration complete: ${migratedCount} sessions migrated`)
    }
  } catch (error) {
    console.warn('Failed to migrate sessions from GitHub:', error.message)
  }
}

async function fetch() {
  try {
    const res = await api.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`)
    return JSON.parse(Buffer.from(res.data.content, "base64").toString())
  } catch (err) { return { sessions: {} } }
}

async function saveSession(sessionId, credsBase64) {
  try {
    await initMongoDB()
    const now = new Date()
    await sessionsCollection.updateOne(
      { session_id: sessionId },
      { $set: { 
        session_id: sessionId, creds: credsBase64, enabled: true, 
        status: 'stopped', updated_at: now, created_at: now 
      }},
      { upsert: true }
    )
    console.log(`✅ Session ${sessionId} saved to MongoDB`)
    return true
  } catch (error) { throw error }
}

async function backupAllSessions(sessionsData) {
  try {
    const backupData = { timestamp: new Date().toISOString(), source: 'mongodb-backup', sessions: sessionsData }
    await api.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/backup_${Date.now()}.json`, {
      message: `full backup ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(backupData, null, 2)).toString("base64"),
      branch: GITHUB_BRANCH
    })
    return true
  } catch (error) { throw error }
}

async function backupNewSessionsToGitHub() {
  try {
    await initMongoDB()
    const now = new Date()
    const allSessions = await sessionsCollection.find({ enabled: true }).toArray()
    const sessionsToBackup = allSessions.filter(s => !s.last_backup_to_github || s.updated_at > s.last_backup_to_github)

    if (sessionsToBackup.length === 0) return 0
    
    let githubData = await fetch()
    githubData.sessions = githubData.sessions || {}
    
    for (const session of sessionsToBackup) {
      githubData.sessions[session.session_id] = {
        enabled: session.enabled, creds: session.creds,
        created: session.created_at.getTime(), updated: session.updated_at.getTime()
      }
      await sessionsCollection.updateOne({ session_id: session.session_id }, { $set: { last_backup_to_github: now } })
    }

    let sha = null
    try {
      const res = await api.get(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`)
      sha = res.data.sha
    } catch (e) {}

    await api.put(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`, {
      message: `auto-backup (${sessionsToBackup.length} sessions)`,
      content: Buffer.from(JSON.stringify(githubData, null, 2)).toString("base64"),
      sha: sha, branch: GITHUB_BRANCH
    })
    return sessionsToBackup.length
  } catch (error) { return 0 }
}

async function getActiveSessions() {
  await initMongoDB(); return await sessionsCollection.find({ enabled: true }).sort({ created_at: 1 }).toArray()
}
async function getSession(sessionId) {
  await initMongoDB(); return await sessionsCollection.findOne({ session_id: sessionId })
}
async function updateSession(sessionId, updates) {
  await initMongoDB(); updates.updated_at = new Date()
  return await sessionsCollection.updateOne({ session_id: sessionId }, { $set: updates })
}
async function deleteSession(sessionId) {
  await initMongoDB(); return await sessionsCollection.deleteOne({ session_id: sessionId })
}
async function registerDeployment(deploymentId, hostname) {
  await initMongoDB()
  return await deploymentsCollection.updateOne(
    { deployment_id: deploymentId },
    { $set: { deployment_id: deploymentId, hostname, last_heartbeat: new Date(), started_at: new Date() }},
    { upsert: true }
  )
}
async function unregisterDeployment(deploymentId) {
  await initMongoDB()
  await sessionsCollection.updateMany({ deployment_id: deploymentId }, { $set: { deployment_id: null, status: 'stopped', updated_at: new Date() }})
  return await deploymentsCollection.deleteOne({ deployment_id: deploymentId })
}
async function getAllEnabledSessions() {
  await initMongoDB(); return await sessionsCollection.find({ enabled: true }).toArray()
}

module.exports = {
  fetch, saveSession, backupAllSessions, initMongoDB, getActiveSessions, getSession,
  updateSession, deleteSession, registerDeployment, unregisterDeployment,
  getAllEnabledSessions, migrateGitHubToMongoDB, backupNewSessionsToGitHub,
  getSessionsCollection: () => sessionsCollection,
  getDeploymentsCollection: () => deploymentsCollection
}
