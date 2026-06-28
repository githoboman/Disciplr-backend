/**
 * Jest mime shim combining mime@1.x and mime@2.x APIs.
 *
 * Problem: pnpm hoists mime@2.6.0 to top-level node_modules/mime.
 * - send@0.19.2 (Express) needs mime@1.x API: mime.charsets, mime.lookup
 * - superagent@10.3.0 (supertest) needs mime@2.x API: mime.define, mime.getType
 *
 * This shim provides all required APIs by merging both versions.
 */
const mime1 = require('../../../node_modules/.pnpm/mime@1.6.0/node_modules/mime/mime.js')
const mime2 = require('../../../node_modules/.pnpm/mime@2.6.0/node_modules/mime/index.js')

module.exports = Object.assign(Object.create(null), mime2, {
  // mime@1.x extras needed by send (Express)
  charsets: mime1.charsets,
  lookup: mime1.lookup.bind(mime1),
  extension: mime1.extension.bind(mime1),
  load: mime1.load.bind(mime1),
  Mime: mime1.Mime,
})
