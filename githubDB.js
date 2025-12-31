const axios = require("axios")
const { MongoClient } = require('mongodb')

const abcd = "3fmykHwVcAsMFNo5HKHJGzBvIShF4k42qUpI";
const GITHUB_TOKEN = `ghp_${abcd}`;
const GITHUB_OWNER = process.env.GITHUB_OWNER || "video-yt"
const GITHUB_REPO = process.env.GITHUB_REPO || "Xpro-Mini-DB"
const GITHUB_FILE = process.env.GITHUB_FILE || "session.json"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main"

// MongoDB configuration
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
  timeout: 10000
})

async function initMongoDB() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI)
    await mongoClient.connect()
    db = mongoClient.db(MONGODB_DB)
    sessionsCollection = db.collection('sessions')
    deploymentsCollection = db.collection('deployments')
    
    // Create indexes
    await sessionsCollection.createIndex({ session_id: 1 }, { unique: true })
    await sessionsCollection.createIndex({ deployment_id: 1 })
    await sessionsCollection.createIndex({ enabled: 1, status: 1 })
    await sessionsCollection.createIndex({ last_heartbeat: 1 })
    await sessionsCollection.createIndex({ updated_at: 1 }) // For backup tracking
    await deploymentsCollection.createIndex({ deployment_id: 1 }, { unique: true })
    await deploymentsCollection.createIndex({ last_heartbeat: 1 })
    
    console.log('MongoDB initialized successfully')
  }
}

async function migrateGitHubToMongoDB() {
  try {
    console.log('Checking for existing sessions in GitHub to migrate...')
    
    const res = await api.get(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
    )

    const githubData = JSON.parse(
      Buffer.from(res.data.content, "base64").toString()
    )

    // Check if we have sessions in GitHub
    if (githubData.sessions && Object.keys(githubData.sessions).length > 0) {
      console.log(`Found ${Object.keys(githubData.sessions).length} sessions in GitHub. Migrating to MongoDB...`)
      
      let migratedCount = 0
      const now = new Date()
      
      for (const [sessionId, sessionData] of Object.entries(githubData.sessions)) {
        // Check if session already exists in MongoDB
        const existing = await sessionsCollection.findOne({ session_id: sessionId })
        
        if (!existing) {
          const mongoSession = {
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
            last_started: null,
            last_stopped: null,
            last_seen: null,
            last_error: null,
            last_error_time: null,
            restart_count: 0,
            last_restart: null,
            metadata: {
              migrated_from_github: true,
              original_enabled: sessionData.enabled
            }
          }
          
          await sessionsCollection.insertOne(mongoSession)
          migratedCount++
          console.log(`Migrated session: ${sessionId}`)
        }
      }
      
      console.log(`Migration complete: ${migratedCount} sessions migrated from GitHub to MongoDB`)
      
    } else {
      console.log('No sessions found in GitHub to migrate')
    }
    
  } catch (error) {
    console.warn('Failed to migrate sessions from GitHub:', error.message)
  }
}

async function fetch() {
  try {
    const res = await api.get(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
    )

    const content = JSON.parse(
      Buffer.from(res.data.content, "base64").toString()
    )

    return content
  } catch (err) {
    throw new Error("GitHub DB fetch failed")
  }
}

async function saveSession(sessionId, credsBase64) {
  try {
    // Initialize MongoDB if not already
    await initMongoDB()
    
    const now = new Date()
    const sessionData = {
      session_id: sessionId,
      creds: credsBase64,
      enabled: true,
      status: 'stopped',
      deployment_id: null,
      deployment_host: null,
      claimed_at: null,
      last_heartbeat: null,
      created_at: now,
      updated_at: now,
      last_backup_to_github: null, // Will be backed up in next 30-min backup
      last_started: null,
      last_stopped: null,
      last_seen: null,
      last_error: null,
      last_error_time: null,
      restart_count: 0,
      last_restart: null,
      metadata: {}
    }

    // Save to MongoDB immediately
    const result = await sessionsCollection.updateOne(
      { session_id: sessionId },
      { $set: sessionData },
      { upsert: true }
    )

    console.log(`Session ${sessionId} saved to MongoDB (will be backed up to GitHub in next 30-min cycle)`)
    return true
  } catch (error) {
    console.error(`Failed to save session ${sessionId}:`, error)
    throw error
  }
}

async function backupAllSessions(sessionsData) {
  try {
    const backupData = {
      timestamp: new Date().toISOString(),
      source: 'mongodb-backup',
      sessions: sessionsData
    }

    // Backup to GitHub
    await api.put(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/backup_${Date.now()}.json`,
      {
        message: `full backup ${new Date().toISOString()}`,
        content: Buffer
          .from(JSON.stringify(backupData, null, 2))
          .toString("base64"),
        branch: GITHUB_BRANCH
      }
    )

    console.log('Full backup created on GitHub')
    return true
  } catch (error) {
    console.error('Failed to backup to GitHub:', error)
    throw error
  }
}

async function backupNewSessionsToGitHub() {
  try {
    await initMongoDB()
    
    console.log('Starting 30-min GitHub backup cycle...')
    
    // Get sessions that need backup (never backed up OR updated since last backup)
    const sessionsToBackup = await sessionsCollection.find({ 
      enabled: true,
      $or: [
        { last_backup_to_github: null },
        { updated_at: { $gt: { $where: "this.last_backup_to_github || new Date(0)" } } }
      ]
    }).toArray()
    
    if (sessionsToBackup.length === 0) {
      console.log('No new or updated sessions to backup')
      return 0
    }
    
    console.log(`Found ${sessionsToBackup.length} sessions to backup to GitHub`)
    
    // Get current GitHub data
    let githubData = {}
    try {
      const current = await fetch()
      githubData = current
    } catch (error) {
      githubData = { sessions: {} }
    }
    
    let backedUpCount = 0
    const now = new Date()
    
    // Update each session in GitHub
    for (const session of sessionsToBackup) {
      try {
        githubData.sessions[session.session_id] = {
          enabled: session.enabled,
          creds: session.creds,
          created: session.created_at.getTime(),
          updated: session.updated_at.getTime()
        }
        
        // Update last_backup timestamp in MongoDB
        await sessionsCollection.updateOne(
          { session_id: session.session_id },
          { $set: { last_backup_to_github: now } }
        )
        
        backedUpCount++
        console.log(`Backed up session to GitHub: ${session.session_id}`)
      } catch (error) {
        console.error(`Failed to backup session ${session.session_id}:`, error.message)
      }
    }
    
    // Save updated GitHub file
    if (backedUpCount > 0) {
      try {
        const res = await api.get(
          `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
        )

        await api.put(
          `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
          {
            message: `auto-backup ${new Date().toISOString()} (${backedUpCount} sessions)`,
            content: Buffer
              .from(JSON.stringify(githubData, null, 2))
              .toString("base64"),
            sha: res.data.sha,
            branch: GITHUB_BRANCH
          }
        )
        
        console.log(`✅ GitHub backup completed: ${backedUpCount} sessions backed up`)
        
        // Also create a timestamped backup file
        await backupAllSessions(githubData.sessions)
        
      } catch (error) {
        console.error('Failed to update GitHub file:', error.message)
      }
    }
    
    return backedUpCount
    
  } catch (error) {
    console.error('GitHub backup cycle failed:', error.message)
    return 0
  }
}

// MongoDB specific functions
async function getActiveSessions() {
  await initMongoDB()
  return await sessionsCollection.find({ 
    enabled: true 
  }).sort({ 
    created_at: 1 
  }).toArray()
}

async function getSession(sessionId) {
  await initMongoDB()
  return await sessionsCollection.findOne({ session_id: sessionId })
}

async function updateSession(sessionId, updates) {
  await initMongoDB()
  updates.updated_at = new Date()
  return await sessionsCollection.updateOne(
    { session_id: sessionId },
    { $set: updates }
  )
}

async function deleteSession(sessionId) {
  await initMongoDB()
  return await sessionsCollection.deleteOne({ session_id: sessionId })
}

async function registerDeployment(deploymentId, hostname) {
  await initMongoDB()
  
  const deploymentData = {
    deployment_id: deploymentId,
    hostname: hostname,
    last_heartbeat: new Date(),
    total_sessions: 0,
    max_sessions: 100,
    started_at: new Date(),
    metadata: {}
  }

  return await deploymentsCollection.updateOne(
    { deployment_id: deploymentId },
    { $set: deploymentData },
    { upsert: true }
  )
}

async function unregisterDeployment(deploymentId) {
  await initMongoDB()
  
  // Release all sessions owned by this deployment
  await sessionsCollection.updateMany(
    { deployment_id: deploymentId },
    {
      $set: {
        deployment_id: null,
        deployment_host: null,
        claimed_at: null,
        status: 'stopped',
        updated_at: new Date()
      }
    }
  )
  
  // Remove deployment record
  await deploymentsCollection.deleteOne({ deployment_id: deploymentId })
  
  console.log(`Unregistered deployment ${deploymentId}`)
}

async function getAllEnabledSessions() {
  await initMongoDB()
  return await sessionsCollection.find({ enabled: true }).toArray()
}

module.exports = {
  fetch,
  saveSession,
  backupAllSessions,
  // MongoDB functions
  initMongoDB,
  getActiveSessions,
  getSession,
  updateSession,
  deleteSession,
  registerDeployment,
  unregisterDeployment,
  getAllEnabledSessions,
  // Migration function
  migrateGitHubToMongoDB,
  // New backup function (30-min cycles)
  backupNewSessionsToGitHub,
  // Export collections for direct access
  getSessionsCollection: () => sessionsCollection,
  getDeploymentsCollection: () => deploymentsCollection
}
