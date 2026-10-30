import { readFileSync } from 'node:fs'

// Tabulates replay equivalence rows. Usage: equivalence-summary.ts SUBJECT=ROWS.json [...]

interface Row {
  revision: string
  status: string
  reason?: string
  features?: Record<string, { identical: boolean; differences: string[] }>
  execute?: Record<string, { casesIdentical: boolean; cacheIdentical: boolean; cacheDifferences: string[]; cases: number; failed: number }>
  executeBuildsIdentical?: { cases: boolean; cache: boolean; cacheDifferences: string[] }
  maskedAgainstRecording?: Record<string, number>
}

export function summarizeEquivalence(subject: string, rows: Row[]) {
  const count = (predicate: (row: Row) => boolean) => rows.filter(predicate).length
  const builds = ['old', 'new']
  const mismatches = rows.flatMap((row) => {
    if (row.status !== 'completed') {
      return [{ revision: row.revision, check: 'replay', detail: row.reason }]
    }
    return [
      ...builds.filter(build => !row.features?.[build].identical).map(build => ({ revision: row.revision, check: `features ${build} vs recorded`, detail: row.features?.[build].differences })),
      ...builds.filter(build => !row.execute?.[build].casesIdentical).map(build => ({ revision: row.revision, check: `cases ${build} vs recorded` })),
      ...builds.filter(build => !row.execute?.[build].cacheIdentical).map(build => ({ revision: row.revision, check: `cache ${build} vs recorded`, detail: row.execute?.[build].cacheDifferences })),
      ...row.executeBuildsIdentical?.cases ? [] : [{ revision: row.revision, check: 'cases old vs new' }],
      ...row.executeBuildsIdentical?.cache ? [] : [{ revision: row.revision, check: 'cache old vs new', detail: row.executeBuildsIdentical?.cacheDifferences }],
    ]
  })
  const masked = rows.reduce<Record<string, number>>((sum, row) => {
    for (const [key, value] of Object.entries(row.maskedAgainstRecording ?? {})) {
      sum[key] = (sum[key] ?? 0) + value
    }
    return sum
  }, {})
  return {
    subject,
    revisions: rows.length,
    completed: count(row => row.status === 'completed'),
    featuresIdentical: Object.fromEntries(builds.map(build => [build, count(row => Boolean(row.features?.[build].identical))])),
    casesIdentical: Object.fromEntries(builds.map(build => [build, count(row => Boolean(row.execute?.[build].casesIdentical))])),
    cacheIdenticalMasked: Object.fromEntries(builds.map(build => [build, count(row => Boolean(row.execute?.[build].cacheIdentical))])),
    oldVsNew: { cases: count(row => Boolean(row.executeBuildsIdentical?.cases)), cache: count(row => Boolean(row.executeBuildsIdentical?.cache)) },
    cases: rows.reduce((sum, row) => sum + (row.execute?.new.cases ?? 0), 0),
    failedCases: rows.reduce((sum, row) => sum + (row.execute?.new.failed ?? 0), 0),
    maskedFieldsAgainstRecording: masked,
    mismatches,
  }
}

if (process.argv[2]) {
  for (const argument of process.argv.slice(2)) {
    const [subject, path] = argument.split('=')
    process.stdout.write(`${JSON.stringify(summarizeEquivalence(subject, JSON.parse(readFileSync(path, 'utf8'))), null, 2)}\n`)
  }
}
