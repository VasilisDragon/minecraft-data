/* eslint-env mocha */
const assert = require('assert')
const path = require('path')
const { crossReferenceIntegrity, loadVersion, findTagsVersions } = require('../tagsValidator')

const ROOT = path.join(__dirname, '../../..')
const dataPaths = require('../../../data/dataPaths.json')

describe('tags referential integrity', function () {
  this.timeout(60 * 1000)
  for (const [edition, version] of findTagsVersions(dataPaths)) {
    it(`${edition} ${version}: every tag member resolves in its registry`, function () {
      const loaded = loadVersion(ROOT, dataPaths, edition, version)
      const r = crossReferenceIntegrity(loaded.tags, loaded.references)
      assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors.slice(0, 10), null, 2))
    })
  }
})
