const { Client } = require('pg')
const Logger = require('./Logger')

class KoyebDB {
  constructor() {
    this.client = null
    this.connected = false
  }

  async initialize() {
    try {
      this.client = new Client({
      host: process.env.DATABASE_HOST || 'ep-wispy-field-a1j9zyp8.ap-southeast-1.pg.koyeb.app',
      user: process.env.DATABASE_USER || 'koyeb-adm',
      password: process.env.DATABASE_PASSWORD || 'npg_oywHt34WEZdX',
      database: process.env.DATABASE_NAME || 'koyebdb',
      port: parseInt(process.env.DATABASE_PORT) || 5432,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
        idle_in_transaction_session_timeout: 10000
      })

      await this.client.connect()
      await this.createTables()
      this.connected = true
      
      Logger.info('Koyeb PostgreSQL database initialized with deployment coordination')
    } catch (error) {
      Logger.error('Failed to initialize database:', error)
      throw error
    }
  }

  async createTables() {
    const createSessionsTable = `
      CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        creds TEXT NOT NULL,
        enabled BOOLEAN DEFAULT true,
        status VARCHAR(50) DEFAULT 'stopped',
        
        -- Deployment tracking
        deployment_id VARCHAR(255),
        deployment_host VARCHAR(255),
        claimed_at TIMESTAMP,
        last_heartbeat TIMESTAMP,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_started TIMESTAMP,
        last_stopped TIMESTAMP,
        last_seen TIMESTAMP,
        
        -- Error tracking
        last_error TEXT,
        last_error_time TIMESTAMP,
        restart_count INTEGER DEFAULT 0,
        last_restart TIMESTAMP,
        
        -- Metadata
        metadata JSONB DEFAULT '{}'
      )
    `

    const createDeploymentsTable = `
      CREATE TABLE IF NOT EXISTS deployments (
        deployment_id VARCHAR(255) PRIMARY KEY,
        hostname VARCHAR(255),
        last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_sessions INTEGER DEFAULT 0,
        max_sessions INTEGER DEFAULT 100,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB DEFAULT '{}'
      )
    `

    await this.client.query(createSessionsTable)
    await this.client.query(createDeploymentsTable)
    
    // Create indexes
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_deployment 
      ON sessions(deployment_id) 
      WHERE deployment_id IS NOT NULL
    `)
    
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_enabled_status 
      ON sessions(enabled, status)
    `)
    
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat 
      ON sessions(last_heartbeat)
    `)
    
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_deployments_heartbeat 
      ON deployments(last_heartbeat)
    `)
  }

  async registerDeployment(deploymentId, hostname) {
    const query = `
      INSERT INTO deployments (deployment_id, hostname, last_heartbeat)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (deployment_id) 
      DO UPDATE SET 
        hostname = EXCLUDED.hostname,
        last_heartbeat = CURRENT_TIMESTAMP
      RETURNING *
    `
    
    const result = await this.client.query(query, [deploymentId, hostname])
    return result.rows[0]
  }

  async unregisterDeployment(deploymentId) {
    // Release all sessions owned by this deployment
    const releaseQuery = `
      UPDATE sessions 
      SET 
        deployment_id = NULL,
        deployment_host = NULL,
        claimed_at = NULL,
        status = 'stopped',
        updated_at = CURRENT_TIMESTAMP
      WHERE deployment_id = $1
      RETURNING session_id
    `
    
    await this.client.query(releaseQuery, [deploymentId])
    
    // Remove deployment record
    const deleteQuery = 'DELETE FROM deployments WHERE deployment_id = $1'
    await this.client.query(deleteQuery, [deploymentId])
    
    Logger.info(`Unregistered deployment ${deploymentId}`)
  }

  async claimSession(sessionId, deploymentId, deploymentHost) {
    // Use advisory lock to prevent race conditions
    const lockKey = `session_claim_${sessionId}`.hashCode()
    
    try {
      // Try to get advisory lock
      await this.client.query('SELECT pg_advisory_xact_lock($1)', [lockKey])
      
      // Check if session is already claimed by another deployment
      const checkQuery = `
        SELECT deployment_id FROM sessions 
        WHERE session_id = $1 
        AND (deployment_id IS NULL OR deployment_id = $2)
        FOR UPDATE
      `
      
      const checkResult = await this.client.query(checkQuery, [sessionId, deploymentId])
      
      if (checkResult.rows.length === 0) {
        // Session is claimed by another deployment
        return false
      }
      
      // Claim the session
      const claimQuery = `
        UPDATE sessions 
        SET 
          deployment_id = $1,
          deployment_host = $2,
          claimed_at = CURRENT_TIMESTAMP,
          last_heartbeat = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE session_id = $3
        AND enabled = true
        RETURNING session_id
      `
      
      const result = await this.client.query(claimQuery, [deploymentId, deploymentHost, sessionId])
      
      return result.rows.length > 0
      
    } catch (error) {
      Logger.error(`Failed to claim session ${sessionId}:`, error)
      return false
    }
  }

  async releaseSession(sessionId) {
    const query = `
      UPDATE sessions 
      SET 
        deployment_id = NULL,
        deployment_host = NULL,
        claimed_at = NULL,
        status = 'stopped',
        updated_at = CURRENT_TIMESTAMP
      WHERE session_id = $1
      RETURNING session_id
    `
    
    const result = await this.client.query(query, [sessionId])
    return result.rows.length > 0
  }

  async updateHeartbeat(sessionId) {
    const query = `
      UPDATE sessions 
      SET last_heartbeat = CURRENT_TIMESTAMP
      WHERE session_id = $1
    `
    
    await this.client.query(query, [sessionId])
  }

  async updateDeploymentHeartbeat(deploymentId) {
    const query = `
      UPDATE deployments 
      SET 
        last_heartbeat = CURRENT_TIMESTAMP,
        total_sessions = (
          SELECT COUNT(*) FROM sessions 
          WHERE deployment_id = $1 AND status = 'running'
        )
      WHERE deployment_id = $1
    `
    
    await this.client.query(query, [deploymentId])
  }

  async getActiveSessions() {
    const query = `
      SELECT * FROM sessions 
      WHERE enabled = true 
      ORDER BY 
        -- Prefer sessions not claimed by any deployment
        CASE WHEN deployment_id IS NULL THEN 0 ELSE 1 END,
        created_at ASC
    `
    
    const result = await this.client.query(query)
    return result.rows
  }

  async getSessionsByDeployment(deploymentId) {
    const query = `
      SELECT * FROM sessions 
      WHERE deployment_id = $1
      ORDER BY claimed_at ASC
    `
    
    const result = await this.client.query(query, [deploymentId])
    return result.rows
  }

  async getSession(sessionId) {
    const query = 'SELECT * FROM sessions WHERE session_id = $1'
    const result = await this.client.query(query, [sessionId])
    return result.rows[0]
  }

  async updateSessionStatus(sessionId, status, metadata = {}) {
    const query = `
      UPDATE sessions 
      SET 
        status = $1,
        updated_at = CURRENT_TIMESTAMP,
        metadata = metadata || $2::jsonb,
        last_heartbeat = CURRENT_TIMESTAMP
      WHERE session_id = $3
      RETURNING *
    `
    
    const result = await this.client.query(query, [status, JSON.stringify(metadata), sessionId])
    return result.rows[0]
  }

  async cleanupDeadDeployments(timeoutSeconds = 60) {
    // Find deployments that haven't sent heartbeat in timeoutSeconds
    const findDeadQuery = `
      SELECT deployment_id FROM deployments 
      WHERE last_heartbeat < NOW() - INTERVAL '${timeoutSeconds} seconds'
    `
    
    const deadResult = await this.client.query(findDeadQuery)
    const deadDeployments = deadResult.rows.map(row => row.deployment_id)
    
    let totalReleased = 0
    
    // Release sessions from dead deployments
    for (const deploymentId of deadDeployments) {
      const releaseQuery = `
        UPDATE sessions 
        SET 
          deployment_id = NULL,
          deployment_host = NULL,
          claimed_at = NULL,
          status = 'stopped',
          updated_at = CURRENT_TIMESTAMP
        WHERE deployment_id = $1
        RETURNING session_id
      `
      
      const releaseResult = await this.client.query(releaseQuery, [deploymentId])
      totalReleased += releaseResult.rowCount
      
      // Remove dead deployment record
      await this.client.query('DELETE FROM deployments WHERE deployment_id = $1', [deploymentId])
      
      Logger.warn(`Cleaned up deployment ${deploymentId}, released ${releaseResult.rowCount} sessions`)
    }
    
    return totalReleased
  }

  async getDeploymentStats() {
    const query = `
      SELECT 
        d.deployment_id,
        d.hostname,
        d.last_heartbeat,
        d.total_sessions,
        d.started_at,
        COUNT(s.session_id) as claimed_sessions,
        SUM(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) as running_sessions
      FROM deployments d
      LEFT JOIN sessions s ON d.deployment_id = s.deployment_id
      GROUP BY d.deployment_id, d.hostname, d.last_heartbeat, d.total_sessions, d.started_at
      ORDER BY d.last_heartbeat DESC
    `
    
    const result = await this.client.query(query)
    return result.rows
  }

  async saveSession(sessionId, creds, enabled = true) {
    const query = `
      INSERT INTO sessions (session_id, creds, enabled, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (session_id) 
      DO UPDATE SET 
        creds = EXCLUDED.creds,
        enabled = EXCLUDED.enabled,
        deployment_id = NULL, -- Reset deployment when session is updated
        claimed_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `
    
    const result = await this.client.query(query, [sessionId, creds, enabled])
    return result.rows[0]
  }

  async incrementRestartCount(sessionId) {
    const query = `
      UPDATE sessions 
      SET restart_count = restart_count + 1
      WHERE session_id = $1
      RETURNING restart_count
    `
    
    const result = await this.client.query(query, [sessionId])
    return result.rows[0]?.restart_count || 0
  }

  async close() {
    if (this.client) {
      await this.client.end()
      this.connected = false
    }
  }
}

// Helper function to generate hash code for advisory locks
String.prototype.hashCode = function() {
  let hash = 0
  for (let i = 0; i < this.length; i++) {
    const char = this.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash)
}

module.exports = new KoyebDB()