const GitHubDB = require('./githubDB')
const Logger = require('../core/Logger')

class KoyebDB {
  constructor() {
    this.connected = false
    this.backupInterval = null
  }

  async initialize() {
    try {
      // Initialize MongoDB connection
      await GitHubDB.initMongoDB()
      
      // Migrate existing sessions from GitHub to MongoDB
      await GitHubDB.migrateGitHubToMongoDB()
      
      this.connected = true
      
      // Setup 30-minute GitHub backup
      this.setupGitHubBackup()
      
      Logger.info('MongoDB database initialized with 30-min GitHub backup')
    } catch (error) {
      Logger.error('Failed to initialize database:', error)
      throw error
    }
  }

  setupGitHubBackup() {
    // Clear any existing interval
    if (this.backupInterval) {
      clearInterval(this.backupInterval)
    }
    
    // Setup 30-minute GitHub backup (30 * 60 * 1000 = 1800000 ms)
    this.backupInterval = setInterval(async () => {
      try {
        Logger.info('Starting scheduled GitHub backup (30-min cycle)...')
        const backedUpCount = await GitHubDB.backupNewSessionsToGitHub()
        if (backedUpCount > 0) {
          Logger.info(`GitHub backup completed: ${backedUpCount} sessions backed up`)
        }
      } catch (error) {
        Logger.error('Scheduled GitHub backup failed:', error)
      }
    }, 30 * 60 * 1000) // 30 minutes
    
    // Run first backup after 1 minute (give time for system to stabilize)
    setTimeout(async () => {
      try {
        Logger.info('Running initial GitHub backup...')
        const backedUpCount = await GitHubDB.backupNewSessionsToGitHub()
        if (backedUpCount > 0) {
          Logger.info(`Initial GitHub backup completed: ${backedUpCount} sessions backed up`)
        }
      } catch (error) {
        Logger.error('Initial GitHub backup failed:', error)
      }
    }, 60000) // 1 minute
  }

  async registerDeployment(deploymentId, hostname) {
    await GitHubDB.registerDeployment(deploymentId, hostname)
    return { deployment_id: deploymentId, hostname: hostname, last_heartbeat: new Date() }
  }

  async unregisterDeployment(deploymentId) {
    await GitHubDB.unregisterDeployment(deploymentId)
    Logger.info(`Unregistered deployment ${deploymentId}`)
  }

  async claimSession(sessionId, deploymentId, deploymentHost) {
    try {
      const sessionsCollection = GitHubDB.getSessionsCollection()
      
      // Find the session
      const session = await sessionsCollection.findOne({ 
        session_id: sessionId,
        enabled: true 
      })
      
      if (!session) {
        return false
      }
      
      // Check if session is already claimed by another deployment
      if (session.deployment_id && session.deployment_id !== deploymentId) {
        return false
      }
      
      // Claim the session
      const result = await sessionsCollection.updateOne(
        { 
          session_id: sessionId,
          $or: [
            { deployment_id: null },
            { deployment_id: deploymentId }
          ]
        },
        {
          $set: {
            deployment_id: deploymentId,
            deployment_host: deploymentHost,
            claimed_at: new Date(),
            last_heartbeat: new Date(),
            updated_at: new Date()
          }
        }
      )
      
      return result.modifiedCount > 0
      
    } catch (error) {
      Logger.error(`Failed to claim session ${sessionId}:`, error)
      return false
    }
  }

  async releaseSession(sessionId) {
    const sessionsCollection = GitHubDB.getSessionsCollection()
    const result = await sessionsCollection.updateOne(
      { session_id: sessionId },
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
    
    return result.modifiedCount > 0
  }

  async updateHeartbeat(sessionId) {
    const sessionsCollection = GitHubDB.getSessionsCollection()
    await sessionsCollection.updateOne(
      { session_id: sessionId },
      { $set: { last_heartbeat: new Date() } }
    )
  }

  async updateDeploymentHeartbeat(deploymentId) {
    const deploymentsCollection = GitHubDB.getDeploymentsCollection()
    const sessionsCollection = GitHubDB.getSessionsCollection()
    
    // Count running sessions
    const runningSessionsCount = await sessionsCollection.countDocuments({
      deployment_id: deploymentId,
      status: 'running'
    })
    
    await deploymentsCollection.updateOne(
      { deployment_id: deploymentId },
      {
        $set: {
          last_heartbeat: new Date(),
          total_sessions: runningSessionsCount
        }
      }
    )
  }

  async getActiveSessions() {
    const sessions = await GitHubDB.getActiveSessions()
    return sessions.map(session => ({
      ...session,
      session_id: session.session_id,
      creds: session.creds,
      enabled: session.enabled,
      status: session.status,
      deployment_id: session.deployment_id,
      deployment_host: session.deployment_host,
      claimed_at: session.claimed_at,
      last_heartbeat: session.last_heartbeat,
      created_at: session.created_at,
      updated_at: session.updated_at
    }))
  }

  async getSessionsByDeployment(deploymentId) {
    const sessionsCollection = GitHubDB.getSessionsCollection()
    const sessions = await sessionsCollection.find({ 
      deployment_id: deploymentId 
    }).sort({ 
      claimed_at: 1 
    }).toArray()
    
    return sessions.map(session => ({
      ...session,
      session_id: session.session_id,
      creds: session.creds,
      enabled: session.enabled,
      status: session.status
    }))
  }

  async getSession(sessionId) {
    const session = await GitHubDB.getSession(sessionId)
    if (!session) return null
    
    return {
      ...session,
      session_id: session.session_id,
      creds: session.creds,
      enabled: session.enabled,
      deployment_id: session.deployment_id
    }
  }

  async updateSessionStatus(sessionId, status, metadata = {}) {
    const sessionsCollection = GitHubDB.getSessionsCollection()
    
    const updateData = {
      status: status,
      updated_at: new Date(),
      last_heartbeat: new Date()
    }
    
    if (metadata) {
      updateData.$set = updateData.$set || {}
      for (const [key, value] of Object.entries(metadata)) {
        updateData.$set[`metadata.${key}`] = value
      }
    }
    
    const result = await sessionsCollection.findOneAndUpdate(
      { session_id: sessionId },
      { $set: updateData },
      { returnDocument: 'after' }
    )
    
    return result.value
  }

  async cleanupDeadDeployments(timeoutSeconds = 60) {
    const deploymentsCollection = GitHubDB.getDeploymentsCollection()
    const sessionsCollection = GitHubDB.getSessionsCollection()
    
    const cutoffTime = new Date(Date.now() - timeoutSeconds * 1000)
    
    // Find dead deployments
    const deadDeployments = await deploymentsCollection.find({
      last_heartbeat: { $lt: cutoffTime }
    }).toArray()
    
    let totalReleased = 0
    
    for (const deployment of deadDeployments) {
      // Release sessions from dead deployment
      const result = await sessionsCollection.updateMany(
        { deployment_id: deployment.deployment_id },
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
      
      totalReleased += result.modifiedCount
      
      // Remove dead deployment
      await deploymentsCollection.deleteOne({ 
        deployment_id: deployment.deployment_id 
      })
      
      Logger.warn(`Cleaned up deployment ${deployment.deployment_id}, released ${result.modifiedCount} sessions`)
    }
    
    return totalReleased
  }

  async getDeploymentStats() {
    const deploymentsCollection = GitHubDB.getDeploymentsCollection()
    const sessionsCollection = GitHubDB.getSessionsCollection()
    
    const deployments = await deploymentsCollection.find({}).toArray()
    const stats = []
    
    for (const deployment of deployments) {
      const claimedSessions = await sessionsCollection.countDocuments({
        deployment_id: deployment.deployment_id
      })
      
      const runningSessions = await sessionsCollection.countDocuments({
        deployment_id: deployment.deployment_id,
        status: 'running'
      })
      
      stats.push({
        deployment_id: deployment.deployment_id,
        hostname: deployment.hostname,
        last_heartbeat: deployment.last_heartbeat,
        total_sessions: deployment.total_sessions,
        started_at: deployment.started_at,
        claimed_sessions: claimedSessions,
        running_sessions: runningSessions
      })
    }
    
    return stats.sort((a, b) => b.last_heartbeat - a.last_heartbeat)
  }

  async saveSession(sessionId, creds, enabled = true) {
    const now = new Date()
    const sessionData = {
      session_id: sessionId,
      creds: creds,
      enabled: enabled,
      status: 'stopped',
      deployment_id: null,
      claimed_at: null,
      updated_at: now,
      created_at: now,
      last_heartbeat: null,
      last_backup_to_github: null, // Will be backed up in next 30-min cycle
      restart_count: 0,
      metadata: {}
    }
    
    const sessionsCollection = GitHubDB.getSessionsCollection()
    const result = await sessionsCollection.updateOne(
      { session_id: sessionId },
      { $set: sessionData },
      { upsert: true }
    )
    
    Logger.info(`Session ${sessionId} saved to MongoDB (GitHub backup in next 30-min cycle)`)
    
    return { session_id: sessionId, ...sessionData }
  }

  async deleteSession(sessionId) {
    try {
      const result = await GitHubDB.deleteSession(sessionId)
      Logger.warn(`Session ${sessionId} deleted from MongoDB.`)
      return result.deletedCount > 0
    } catch (error) {
      Logger.error(`Failed to delete session ${sessionId}:`, error)
      return false
    }
  }

  async incrementRestartCount(sessionId) {
    const sessionsCollection = GitHubDB.getSessionsCollection()
    const result = await sessionsCollection.findOneAndUpdate(
      { session_id: sessionId },
      { 
        $inc: { restart_count: 1 },
        $set: { last_restart: new Date() }
      },
      { returnDocument: 'after' }
    )
    
    return result.value?.restart_count || 0
  }

  async close() {
    // Clear backup interval
    if (this.backupInterval) {
      clearInterval(this.backupInterval)
    }
    
    // One final backup before closing
    Logger.info('Running final GitHub backup before shutdown...')
    const backedUpCount = await GitHubDB.backupNewSessionsToGitHub()
    if (backedUpCount > 0) {
      Logger.info(`Final backup completed: ${backedUpCount} sessions backed up to GitHub`)
    }
    
    this.connected = false
    Logger.info('Database connection closed')
  }
}

module.exports = new KoyebDB()
