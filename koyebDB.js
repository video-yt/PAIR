const GitHubDB = require('./githubDB')
const Logger = require('./Logger')

class KoyebDB {
  constructor() {
    this.connected = false
    this.backupInterval = null
  }

  async initialize() {
    try {
      await GitHubDB.initMongoDB()
      await GitHubDB.migrateGitHubToMongoDB()
      this.connected = true
      this.setupGitHubBackup()
      Logger.info('MongoDB database initialized')
    } catch (error) {
      Logger.error('Failed to initialize database:', error)
      throw error
    }
  }

  setupGitHubBackup() {
    if (this.backupInterval) clearInterval(this.backupInterval)
    this.backupInterval = setInterval(async () => {
      try {
        await GitHubDB.backupNewSessionsToGitHub()
      } catch (e) {}
    }, 30 * 60 * 1000)
    
    setTimeout(() => GitHubDB.backupNewSessionsToGitHub(), 30000)
  }

  async registerDeployment(deploymentId, hostname) {
    try {
      await GitHubDB.registerDeployment(deploymentId, hostname)
      return { deployment_id: deploymentId, hostname: hostname, last_heartbeat: new Date() }
    } catch (error) { throw error }
  }

  async unregisterDeployment(deploymentId) {
    try { await GitHubDB.unregisterDeployment(deploymentId) } catch (e) {}
  }

  async claimSession(sessionId, deploymentId, deploymentHost) {
    try {
      const col = GitHubDB.getSessionsCollection()
      const result = await col.findOneAndUpdate(
        { 
          session_id: sessionId, enabled: true,
          $or: [{ deployment_id: null }, { deployment_id: deploymentId }]
        },
        { $set: { deployment_id: deploymentId, deployment_host: deploymentHost, claimed_at: new Date(), last_heartbeat: new Date(), updated_at: new Date() }},
        { returnDocument: 'after' }
      )
      return !!result
    } catch (error) { return false }
  }

  async releaseSession(sessionId) {
    try {
      const col = GitHubDB.getSessionsCollection()
      const result = await col.updateOne({ session_id: sessionId }, { $set: { deployment_id: null, deployment_host: null, claimed_at: null, status: 'stopped', updated_at: new Date() }})
      return result.modifiedCount > 0
    } catch (error) { return false }
  }

  async updateHeartbeat(sessionId) {
    try {
      const col = GitHubDB.getSessionsCollection()
      await col.updateOne({ session_id: sessionId }, { $set: { last_heartbeat: new Date() } })
    } catch (e) {}
  }

  // New: Bulk heartbeat for performance
  async bulkUpdateHeartbeats(sessionIds, deploymentId) {
    try {
      const sCol = GitHubDB.getSessionsCollection()
      const dCol = GitHubDB.getDeploymentsCollection()
      const now = new Date()
      await sCol.updateMany({ session_id: { $in: sessionIds } }, { $set: { last_heartbeat: now } })
      await dCol.updateOne({ deployment_id: deploymentId }, { $set: { last_heartbeat: now, total_sessions: sessionIds.length } })
    } catch (e) {}
  }

  async updateDeploymentHeartbeat(deploymentId) {
    try {
      const dCol = GitHubDB.getDeploymentsCollection()
      const sCol = GitHubDB.getSessionsCollection()
      const count = await sCol.countDocuments({ deployment_id: deploymentId, status: 'running' })
      await dCol.updateOne({ deployment_id: deploymentId }, { $set: { last_heartbeat: new Date(), total_sessions: count } })
    } catch (e) {}
  }

  async getActiveSessions() {
    try {
      const sessions = await GitHubDB.getActiveSessions()
      return sessions.map(s => ({ ...s, restart_count: s.restart_count || 0 }))
    } catch (e) { return [] }
  }

  async getSessionsByDeployment(deploymentId) {
    try {
      const col = GitHubDB.getSessionsCollection()
      return await col.find({ deployment_id: deploymentId }).sort({ claimed_at: 1 }).toArray()
    } catch (e) { return [] }
  }

  async getSession(sessionId) {
    try { return await GitHubDB.getSession(sessionId) } catch (e) { return null }
  }

  async updateSessionStatus(sessionId, status, metadata = {}) {
    try {
      const col = GitHubDB.getSessionsCollection()
      const res = await col.findOneAndUpdate({ session_id: sessionId }, { $set: { status, updated_at: new Date(), ...metadata } }, { returnDocument: 'after' })
      return res
    } catch (e) { return null }
  }

  async cleanupDeadDeployments(timeoutSeconds = 60) {
    try {
      const dCol = GitHubDB.getDeploymentsCollection()
      const sCol = GitHubDB.getSessionsCollection()
      const cutoff = new Date(Date.now() - timeoutSeconds * 1000)
      const dead = await dCol.find({ last_heartbeat: { $lt: cutoff } }).toArray()
      let total = 0
      for (const d of dead) {
        const res = await sCol.updateMany({ deployment_id: d.deployment_id }, { $set: { deployment_id: null, status: 'stopped', updated_at: new Date() }})
        total += res.modifiedCount
        await dCol.deleteOne({ deployment_id: d.deployment_id })
      }
      return total
    } catch (e) { return 0 }
  }

  async getDeploymentStats() {
    try {
      const dCol = GitHubDB.getDeploymentsCollection()
      const sCol = GitHubDB.getSessionsCollection()
      const deployments = await dCol.find({}).toArray()
      const stats = []
      for (const d of deployments) {
        const claimed = await sCol.countDocuments({ deployment_id: d.deployment_id })
        const running = await sCol.countDocuments({ deployment_id: d.deployment_id, status: 'running' })
        stats.push({ ...d, claimed_sessions: claimed, running_sessions: running })
      }
      return stats.sort((a, b) => b.last_heartbeat - a.last_heartbeat)
    } catch (e) { return [] }
  }

  async saveSession(sessionId, creds, enabled = true) {
    try {
      const col = GitHubDB.getSessionsCollection()
      await col.updateOne({ session_id: sessionId }, { $set: { session_id: sessionId, creds, enabled, updated_at: new Date() }}, { upsert: true })
      return { session_id: sessionId, enabled, creds }
    } catch (e) { throw e }
  }

  async deleteSession(sessionId) {
    try {
      const res = await GitHubDB.deleteSession(sessionId)
      return res.deletedCount > 0
    } catch (e) { return false }
  }

  async incrementRestartCount(sessionId) {
    try {
      const col = GitHubDB.getSessionsCollection()
      const res = await col.findOneAndUpdate({ session_id: sessionId }, { $inc: { restart_count: 1 }, $set: { last_restart: new Date() } }, { returnDocument: 'after' })
      return res.restart_count || 0
    } catch (e) { return 0 }
  }

  async close() {
    if (this.backupInterval) clearInterval(this.backupInterval)
    try { await GitHubDB.backupNewSessionsToGitHub() } catch (e) {}
    this.connected = false
  }
}

module.exports = new KoyebDB()
