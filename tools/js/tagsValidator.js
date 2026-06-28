const fs = require('fs')
const path = require('path')

const REGISTRY_REFERENCE = {
  block: { key: 'blocks', file: 'blocks.json' },
  item: { key: 'items', file: 'items.json' },
  entity_type: { key: 'entities', file: 'entities.json' }
}
const KNOWN_REGISTRIES = new Set(['block', 'item', 'fluid', 'entity_type', 'game_event', 'worldgen/biome', 'worldgen/structure'])

function validateSchema (tags, schema, Ajv) {
  const errors = []
  try {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
    if (!validate(tags)) {
      for (const e of validate.errors) errors.push({ kind: 'schema', where: e.instancePath ?? e.dataPath ?? '(root)', msg: e.message })
    }
  } catch (e) {
    errors.push({ kind: 'schema', where: '(schema)', msg: `schema failed to compile: ${e.message}` })
  }
  return errors
}

function crossReferenceIntegrity (tags, references = {}) {
  const errors = []
  const warnings = []
  const stats = {}
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return { errors, warnings, stats }
  for (const reg of Object.keys(tags)) {
    if (!KNOWN_REGISTRIES.has(reg)) {
      warnings.push({ kind: 'unknown-registry', registry: reg, msg: `unrecognized registry kind '${reg}'` })
    }
    const tagMap = tags[reg]
    if (!tagMap || typeof tagMap !== 'object') continue
    const ref = references[reg]
    if (Object.prototype.hasOwnProperty.call(REGISTRY_REFERENCE, reg) && !(ref instanceof Set)) {
      errors.push({ kind: 'reference-missing', registry: reg, msg: `reference data for '${reg}' could not be loaded` })
    }
    const s = { checked: 0, resolved: 0, dangling: 0, unverifiable: 0 }
    for (const tag of Object.keys(tagMap)) {
      const members = tagMap[tag]
      if (!Array.isArray(members)) continue
      for (const member of members) {
        if (typeof member !== 'string') continue
        s.checked++
        if (!(ref instanceof Set)) { s.unverifiable++; continue }
        const i = member.indexOf(':')
        const ns = i === -1 ? '' : member.slice(0, i)
        const name = i === -1 ? member : member.slice(i + 1)
        if (ns !== 'minecraft') { s.dangling++; errors.push({ kind: 'xref', registry: reg, tag, member, msg: `${member}: non-vanilla namespace (expected minecraft:)` }); continue }
        if (ref.has(name)) s.resolved++
        else { s.dangling++; errors.push({ kind: 'xref', registry: reg, tag, member, msg: `${member} not found in ${reg} registry` }) }
      }
    }
    stats[reg] = s
  }
  return { errors, warnings, stats }
}

function validateTags ({ tags, schema, references, Ajv }) {
  const schemaErrors = validateSchema(tags, schema, Ajv)
  const x = crossReferenceIntegrity(tags, references)
  return { ok: schemaErrors.length + x.errors.length === 0, errors: schemaErrors.concat(x.errors), warnings: x.warnings, stats: x.stats }
}

function readJson (p) {
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch (e) { throw new Error(`cannot read ${p}: ${e.message}`) }
  try { return JSON.parse(raw) } catch (e) { throw new Error(`invalid JSON in ${p}: ${e.message}`) }
}

function loadVersion (root, dataPaths, edition, version) {
  const dp = dataPaths[edition] && dataPaths[edition][version]
  if (!dp || !dp.tags) return null
  const dir = sub => path.join(root, 'data', sub)
  const tags = readJson(path.join(dir(dp.tags), 'tags.json'))
  const references = {}
  for (const [reg, { key, file }] of Object.entries(REGISTRY_REFERENCE)) {
    if (!dp[key]) continue
    const arr = readJson(path.join(dir(dp[key]), file))
    if (!Array.isArray(arr) || !arr.every(x => x && typeof x.name === 'string')) {
      throw new Error(`reference ${file} for ${edition} ${version} has an unexpected shape`)
    }
    references[reg] = new Set(arr.map(x => x.name))
  }
  return { tags, references }
}

function findTagsVersions (dataPaths, edition, version) {
  const out = []
  for (const ed of edition ? [edition] : Object.keys(dataPaths)) {
    for (const v of Object.keys(dataPaths[ed] || {})) {
      if (version && v !== version) continue
      if (dataPaths[ed][v] && dataPaths[ed][v].tags) out.push([ed, v])
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
}

function printHuman (ed, v, r) {
  const t = Object.values(r.stats).reduce((a, s) => ({ resolved: a.resolved + s.resolved, dangling: a.dangling + s.dangling, unverifiable: a.unverifiable + s.unverifiable }), { resolved: 0, dangling: 0, unverifiable: 0 })
  console.log(`${ed} ${v}: ${r.ok ? 'OK' : 'FAIL'}  (${t.resolved} resolved, ${t.dangling} dangling, ${t.unverifiable} unverifiable)`)
  for (const reg of Object.keys(r.stats)) {
    const s = r.stats[reg]
    console.log(`   ${reg}: ${s.resolved}/${s.checked} resolved` + (s.unverifiable ? `, ${s.unverifiable} unverifiable` : '') + (s.dangling ? `, ${s.dangling} DANGLING` : ''))
  }
  for (const e of r.errors.slice(0, 15)) console.log(`   ! ${e.kind} ${e.member || e.where || e.registry || ''}: ${e.msg}`)
  if (r.errors.length > 15) console.log(`   ! ...and ${r.errors.length - 15} more error(s)`)
  for (const w of r.warnings) console.log(`   ~ ${w.msg}`)
}

function main () {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const [root, edition, version] = args.filter(a => a !== '--json')
  if (!root) { console.error('usage: node tagsValidator.js <minecraft-data-root> [--json] [<edition> [<version>]]'); process.exit(2) }

  let Ajv, schema, dataPaths
  try {
    Ajv = require(path.join(root, 'tools/js/node_modules/ajv'))
    schema = readJson(path.join(root, 'schemas/tags_schema.json'))
    dataPaths = readJson(path.join(root, 'data/dataPaths.json'))
  } catch (e) { console.error('setup error:', e.message); process.exit(2) }

  const targets = findTagsVersions(dataPaths, edition, version)
  if (!targets.length) {
    console.log(json ? JSON.stringify({ ok: true, results: [] }) : 'no tags data found — nothing to validate')
    process.exit(0)
  }

  const results = []
  let bad = 0
  for (const [ed, v] of targets) {
    let loaded
    try { loaded = loadVersion(root, dataPaths, ed, v) } catch (e) { console.error(`setup error (${ed} ${v}): ${e.message}`); process.exit(2) }
    if (!loaded) continue
    const r = validateTags({ ...loaded, schema, Ajv })
    results.push({ edition: ed, version: v, ...r })
    if (!r.ok) bad++
    if (!json) printHuman(ed, v, r)
  }
  if (json) console.log(JSON.stringify({ ok: bad === 0, results }, null, 2))
  process.exit(bad ? 1 : 0)
}

module.exports = { validateSchema, crossReferenceIntegrity, validateTags, loadVersion, findTagsVersions, readJson, REGISTRY_REFERENCE, KNOWN_REGISTRIES }
if (require.main === module) main()
