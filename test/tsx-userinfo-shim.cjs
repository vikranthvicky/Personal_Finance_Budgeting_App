const os = require('node:os')

try {
  os.userInfo()
} catch {
  os.userInfo = () => ({
    username: process.env.USERNAME || process.env.USER || 'pocketplan-test',
    uid: -1,
    gid: -1,
    shell: null,
    homedir: os.tmpdir(),
  })
}
