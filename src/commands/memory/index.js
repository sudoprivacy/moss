// Stub for commands/memory
const memory = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit Claude memory files',
  load: () => Promise.resolve({ default: {} }),
}
module.exports = memory
module.exports.default = memory
