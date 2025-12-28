
const chalk = require('chalk')
module.exports = {
  success: msg => console.log(chalk.green('[OK]'), msg),
  warn: msg => console.log(chalk.yellow('[WARN]'), msg),
  error: msg => console.log(chalk.red('[ERR]'), msg),
  info: msg => console.log(msg)
}
