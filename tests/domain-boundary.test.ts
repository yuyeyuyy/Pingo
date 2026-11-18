import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('compiles the domain with only its own source files and TypeScript standard libraries', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const config = ts.readConfigFile(join(root, 'tsconfig.domain.json'), ts.sys.readFile)
  expect(config.error).toBeUndefined()

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  expect(parsed.errors).toEqual([])
  expect(parsed.fileNames.length).toBeGreaterThan(0)

  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const domain = join(root, 'src', 'domain')
  const externalFiles = program
    .getSourceFiles()
    .filter((file) => !program.isSourceFileDefaultLibrary(file))
    .map((file) => relative(domain, file.fileName))
    .filter((path) => isAbsolute(path) || path.startsWith(`..${sep}`))

  expect(externalFiles).toEqual([])
  expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.messageText)).toEqual([])
})
