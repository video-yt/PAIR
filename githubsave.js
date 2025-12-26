const axios = require("axios")
//========================
let GITHUB_TOKEN = "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"
let GITHUB_OWNER = "video-yt"
let GITHUB_REPO = "Xpro-Mini-DB"
let GITHUB_FILE = "session.json"
let GITHUB_BRANCH = "main"
//========================
const api = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json"
  }
})

async function getFile() {
  const res = await api.get(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
  )
  return {
    sha: res.data.sha,
    content: JSON.parse(
      Buffer.from(res.data.content, "base64").toString()
    )
  }
}

async function saveSession(sessionId, credsBase64) {
  const { sha, content } = await getFile()

  content.sessions ||= {}
  content.sessions[sessionId] = {
    enabled: true,
    creds: credsBase64,
    created: Date.now()
  }

  await api.put(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
    {
      message: `add session ${sessionId}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
      sha,
      branch: GITHUB_BRANCH
    }
  )
}

module.exports = { saveSession }
