// databaseHelper.js
const { Client } = require('pg')

class DatabaseHelper {
  constructor() {
    this.client = null
    this.connected = false
    this.config = {
      host: 'ep-wispy-field-a1j9zyp8.ap-southeast-1.pg.koyeb.app',
      user: 'koyeb-adm',
      password: 'npg_oywHt34WEZdX',
      database: 'koyebdb',
      port: 5432,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000
    }
  }

  async connect() {
    if (this.connected && this.client) return
    
    try {
      this.client = new Client(this.config)
      await this.client.connect()
      this.connected = true
      console.log('✅ Connected to Koyeb PostgreSQL database')
    } catch (error) {
      console.error('❌ Failed to connect to database:', error.message)
      throw error
    }
  }

  async saveSessionToDB(sessionId, credsBase64) {
    if (!this.connected) await this.connect()
    
    // Validate credentials are not empty
    if (!credsBase64 || credsBase64.trim() === '') {
      throw new Error('Empty credentials received')
    }
    
    // Validate it's a valid base64 string
    if (!this.isValidBase64(credsBase64)) {
      throw new Error('Invalid base64 credentials format')
    }

    try {
      const query = `
        INSERT INTO sessions (session_id, creds, enabled, status, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (session_id) 
        DO UPDATE SET 
          creds = EXCLUDED.creds,
          enabled = EXCLUDED.enabled,
          status = EXCLUDED.status,
          updated_at = CURRENT_TIMESTAMP,
          deployment_id = NULL, -- Reset deployment when session is updated
          claimed_at = NULL
        RETURNING session_id
      `
      
      const result = await this.client.query(query, [
        sessionId, 
        credsBase64, 
        true, // enabled
        'pending' // initial status
      ])
      
      console.log(`✅ Session ${sessionId} saved to database successfully`)
      return result.rows[0]
    } catch (error) {
      console.error(`❌ Failed to save session ${sessionId} to database:`, error.message)
      throw error
    }
  }

  async verifySession(sessionId) {
    if (!this.connected) await this.connect()
    
    try {
      const query = 'SELECT session_id, LENGTH(creds) as creds_length FROM sessions WHERE session_id = $1'
      const result = await this.client.query(query, [sessionId])
      
      if (result.rows.length > 0) {
        const session = result.rows[0]
        return {
          exists: true,
          hasCredentials: session.creds_length > 20 // Minimum length check
        }
      }
      return { exists: false, hasCredentials: false }
    } catch (error) {
      console.error(`❌ Failed to verify session ${sessionId}:`, error.message)
      return { exists: false, hasCredentials: false }
    }
  }

  isValidBase64(str) {
    try {
      // Check if it's a valid base64 string
      const buffer = Buffer.from(str, 'base64')
      const decoded = buffer.toString('base64')
      return decoded === str && str.length > 20 // Minimum length check
    } catch {
      return false
    }
  }

  async close() {
    if (this.client) {
      await this.client.end()
      this.connected = false
      console.log('Database connection closed')
    }
  }
}

// Singleton instance
module.exports = new DatabaseHelper()
