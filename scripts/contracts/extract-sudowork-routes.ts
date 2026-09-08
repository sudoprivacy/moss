import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options'])

export interface RouteContract {
  method: string
  path: string
  source_file: string
  source_line: number
  router: string
  mount_chain: string[]
  domain: string
}

interface SymbolExpression {
  root: string
  properties: string[]
}

interface ImportBinding {
  file: string
  exportName: string
}

interface DirectRoute {
  method: string
  path: string
  sourceFile: string
  sourceLine: number
  router: string
}

interface Mount {
  path: string
  child: SymbolExpression
  sourceFile: string
  sourceLine: number
  router: string
}

interface RouterDefinition {
  routes: DirectRoute[]
  mounts: Mount[]
}

interface FileModel {
  file: string
  imports: Map<string, ImportBinding>
  strings: Map<string, string>
  objects: Map<string, Map<string, SymbolExpression>>
  aliases: Map<string, SymbolExpression>
  exports: Map<string, SymbolExpression>
  routers: Map<string, RouterDefinition>
}

interface ExtractionContext {
  sourceRoot: string
  models: Map<string, FileModel>
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function expressionToSymbol(expression: ts.Expression): SymbolExpression | undefined {
  if (ts.isIdentifier(expression)) {
    return { root: expression.text, properties: [] }
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionToSymbol(expression.expression)
    return parent
      ? { root: parent.root, properties: [...parent.properties, expression.name.text] }
      : undefined
  }
  return undefined
}

function literalText(expression: ts.Expression, strings: Map<string, string>): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text
  }
  if (ts.isIdentifier(expression)) {
    return strings.get(expression.text)
  }
  return undefined
}

function resolveImportFile(currentFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) {
    throw new Error(`Only relative route imports are supported: ${specifier} in ${currentFile}`)
  }

  const candidate = resolve(dirname(currentFile), specifier)
  const candidates = [
    candidate,
    candidate.replace(/\.js$/, '.ts'),
    candidate.replace(/\.mjs$/, '.mts'),
    join(candidate, 'index.ts'),
  ]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new Error(`Cannot resolve route import ${specifier} from ${currentFile}`)
  }
  return found
}

function parseObjectLiteral(node: ts.ObjectLiteralExpression): Map<string, SymbolExpression> {
  const properties = new Map<string, SymbolExpression>()
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.text, { root: property.name.text, properties: [] })
      continue
    }
    if (ts.isPropertyAssignment(property)) {
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined
      const value = expressionToSymbol(property.initializer)
      if (name && value) properties.set(name, value)
    }
  }
  return properties
}

function parseFile(file: string): FileModel {
  const sourceText = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const model: FileModel = {
    file,
    imports: new Map(),
    strings: new Map(),
    objects: new Map(),
    aliases: new Map(),
    exports: new Map(),
    routers: new Map(),
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      if (!clause || !statement.moduleSpecifier.text.startsWith('.')) continue
      const importedFile = resolveImportFile(file, statement.moduleSpecifier.text)
      if (clause.name) {
        model.imports.set(clause.name.text, { file: importedFile, exportName: 'default' })
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          model.imports.set(element.name.text, {
            file: importedFile,
            exportName: element.propertyName?.text ?? element.name.text,
          })
        }
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const name = declaration.name.text
        const initializer = declaration.initializer
        if (
          ts.isNewExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === 'Hono'
        ) {
          model.routers.set(name, { routes: [], mounts: [] })
        } else if (ts.isObjectLiteralExpression(initializer)) {
          model.objects.set(name, parseObjectLiteral(initializer))
        } else {
          const stringValue = literalText(initializer, model.strings)
          if (stringValue !== undefined) model.strings.set(name, stringValue)
          const alias = expressionToSymbol(initializer)
          if (alias) model.aliases.set(name, alias)
        }

        if (hasExportModifier(statement)) {
          model.exports.set(name, { root: name, properties: [] })
        }
      }
      continue
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isObjectLiteralExpression(statement.expression)) {
        const syntheticName = '__default_export_object__'
        model.objects.set(syntheticName, parseObjectLiteral(statement.expression))
        model.exports.set('default', { root: syntheticName, properties: [] })
      } else {
        const expression = expressionToSymbol(statement.expression)
        if (expression) model.exports.set('default', expression)
      }
      continue
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        model.exports.set(element.name.text, {
          root: element.propertyName?.text ?? element.name.text,
          properties: [],
        })
      }
    }
  }

  const collectNestedDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text
      const initializer = node.initializer
      if (
        ts.isNewExpression(initializer)
        && ts.isIdentifier(initializer.expression)
        && initializer.expression.text === 'Hono'
      ) {
        if (!model.routers.has(name)) model.routers.set(name, { routes: [], mounts: [] })
      } else if (ts.isObjectLiteralExpression(initializer)) {
        if (!model.objects.has(name)) model.objects.set(name, parseObjectLiteral(initializer))
      } else {
        const stringValue = literalText(initializer, model.strings)
        if (stringValue !== undefined && !model.strings.has(name)) model.strings.set(name, stringValue)
        const alias = expressionToSymbol(initializer)
        if (alias && !model.aliases.has(name)) model.aliases.set(name, alias)
      }
    }
    ts.forEachChild(node, collectNestedDeclarations)
  }
  collectNestedDeclarations(sourceFile)

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression
      const method = node.expression.name.text
      if (ts.isIdentifier(receiver) && model.routers.has(receiver.text)) {
        const router = model.routers.get(receiver.text)!
        if (HTTP_METHODS.has(method)) {
          const pathExpression = node.arguments[0]
          const path = pathExpression && literalText(pathExpression, model.strings)
          if (path === undefined) {
            throw new Error(
              `Cannot statically resolve Hono route path at ${relative(process.cwd(), file)}:${sourceLine(sourceFile, node)}`,
            )
          }
          router.routes.push({
            method: method.toUpperCase(),
            path,
            sourceFile: file,
            sourceLine: sourceLine(sourceFile, node),
            router: receiver.text,
          })
        } else if (method === 'route') {
          const pathExpression = node.arguments[0]
          const childExpression = node.arguments[1]
          const path = pathExpression && literalText(pathExpression, model.strings)
          const child = childExpression && expressionToSymbol(childExpression)
          if (path === undefined || !child) {
            throw new Error(
              `Cannot statically resolve Hono mount at ${relative(process.cwd(), file)}:${sourceLine(sourceFile, node)}`,
            )
          }
          router.mounts.push({
            path,
            child,
            sourceFile: file,
            sourceLine: sourceLine(sourceFile, node),
            router: receiver.text,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return model
}

function loadModel(context: ExtractionContext, file: string): FileModel {
  const existing = context.models.get(file)
  if (existing) return existing
  const model = parseFile(file)
  context.models.set(file, model)
  return model
}

function resolveRouter(
  context: ExtractionContext,
  file: string,
  expression: SymbolExpression,
  seen = new Set<string>(),
): { file: string; name: string } {
  const key = `${file}#${expression.root}.${expression.properties.join('.')}`
  if (seen.has(key)) throw new Error(`Circular route symbol resolution: ${key}`)
  seen.add(key)

  const model = loadModel(context, file)
  if (model.imports.has(expression.root)) {
    const binding = model.imports.get(expression.root)!
    return resolveExport(context, binding.file, binding.exportName, expression.properties, seen)
  }

  const alias = model.aliases.get(expression.root)
  if (alias) {
    return resolveRouter(context, file, {
      root: alias.root,
      properties: [...alias.properties, ...expression.properties],
    }, seen)
  }

  if (expression.properties.length > 0) {
    const object = model.objects.get(expression.root)
    const [property, ...rest] = expression.properties
    const value = object?.get(property)
    if (!value) throw new Error(`Cannot resolve route object property ${key}`)
    return resolveRouter(context, file, {
      root: value.root,
      properties: [...value.properties, ...rest],
    }, seen)
  }

  if (model.routers.has(expression.root)) return { file, name: expression.root }
  throw new Error(`Cannot resolve Hono router ${key}`)
}

function resolveExport(
  context: ExtractionContext,
  file: string,
  exportName: string,
  properties: string[],
  seen: Set<string>,
): { file: string; name: string } {
  const model = loadModel(context, file)
  const exported = model.exports.get(exportName)
  if (!exported) throw new Error(`Cannot resolve export ${exportName} from ${file}`)
  return resolveRouter(context, file, {
    root: exported.root,
    properties: [...exported.properties, ...properties],
  }, seen)
}

function joinRoutePath(prefix: string, path: string): string {
  if (!prefix) return path.startsWith('/') ? path : `/${path}`
  if (path === '/') return `${prefix.replace(/\/$/, '')}/`
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function inferDomain(path: string): string {
  if (path.startsWith('/api/v1/auth')) return 'identity'
  if (path.startsWith('/api/v1/admin/dify')) return 'dify'
  if (path.startsWith('/api/v1/admin')) return 'admin'
  if (path.startsWith('/api/v1/agents')) return 'agent_skill'
  if (path.startsWith('/api/v1/recharge') || path.startsWith('/api/v1/credit-applications')) return 'billing'
  if (path.includes('/qms/') || path.startsWith('/api/v1/telemetry') || path.startsWith('/api/v1/crash')) return 'qms'
  if (path.startsWith('/api/v1/user')) return 'user'
  if (path.startsWith('/api/')) return 'integration'
  return 'ui'
}

export function extractHonoRoutes(sourceRoot: string, entryRelative = 'src/index.ts'): RouteContract[] {
  const absoluteRoot = resolve(sourceRoot)
  const entryFile = isAbsolute(entryRelative) ? entryRelative : join(absoluteRoot, entryRelative)
  const context: ExtractionContext = { sourceRoot: absoluteRoot, models: new Map() }
  const entry = loadModel(context, entryFile)
  const root = entry.routers.has('app')
    ? { file: entryFile, name: 'app' }
    : resolveExport(context, entryFile, 'default', [], new Set())
  const results: RouteContract[] = []

  const expand = (
    routerRef: { file: string; name: string },
    prefix: string,
    mountChain: string[],
    ancestry: Set<string>,
  ): void => {
    const routerKey = `${routerRef.file}#${routerRef.name}`
    if (ancestry.has(routerKey)) throw new Error(`Circular Hono mount graph: ${routerKey}`)
    const nextAncestry = new Set(ancestry).add(routerKey)
    const model = loadModel(context, routerRef.file)
    const router = model.routers.get(routerRef.name)
    if (!router) throw new Error(`Missing Hono router definition: ${routerKey}`)

    for (const route of router.routes) {
      const path = joinRoutePath(prefix, route.path)
      results.push({
        method: route.method,
        path,
        source_file: relative(absoluteRoot, route.sourceFile),
        source_line: route.sourceLine,
        router: route.router,
        mount_chain: mountChain,
        domain: inferDomain(path),
      })
    }

    for (const mount of router.mounts) {
      const child = resolveRouter(context, routerRef.file, mount.child)
      const mountedPrefix = joinRoutePath(prefix, mount.path)
      const mountLabel = `${relative(absoluteRoot, mount.sourceFile)}:${mount.sourceLine} ${mount.router}.route(${JSON.stringify(mount.path)})`
      expand(child, mountedPrefix, [...mountChain, mountLabel], nextAncestry)
    }
  }

  expand(root, '', [], new Set())
  return results.sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method)
    || left.source_file.localeCompare(right.source_file)
    || left.source_line - right.source_line,
  )
}

function cliArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function manifestsMatchIgnoringGeneratedAt(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false
  const { generated_at: _leftTimestamp, ...leftComparable } = left as Record<string, unknown>
  const { generated_at: _rightTimestamp, ...rightComparable } = right as Record<string, unknown>
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable)
}

function runCli(): void {
  const sourceRoot = cliArgument('--source') ?? process.env.SUDOWORK_SERVER_ROOT
  if (!sourceRoot) {
    throw new Error('Pass --source /absolute/path or set SUDOWORK_SERVER_ROOT')
  }
  if (!isAbsolute(sourceRoot)) throw new Error('--source must be an absolute path')

  const routes = extractHonoRoutes(sourceRoot).filter((route) => route.path.startsWith('/api'))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  }).trim()
  const output = {
    schema_version: 1,
    source_commit: sourceCommit,
    generated_at: new Date().toISOString(),
    routes,
  }
  const destination = resolve('contracts/sudowork/routes.json')
  if (process.argv.includes('--check')) {
    if (!existsSync(destination)) throw new Error(`Route contract does not exist: ${destination}`)
    const existing = JSON.parse(readFileSync(destination, 'utf8')) as unknown
    if (!manifestsMatchIgnoringGeneratedAt(existing, output)) {
      throw new Error('Sudowork route contract is stale; regenerate contracts/sudowork/routes.json')
    }
    console.log(`Verified ${routes.length} Sudowork API routes from ${sourceCommit}`)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Generated ${routes.length} Sudowork API routes from ${sourceCommit}`)
}

if (import.meta.main) runCli()
