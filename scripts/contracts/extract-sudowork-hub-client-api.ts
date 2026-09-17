import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const CLIENT_HUB_FILES = [
  'src/process/bridge/skillHubBridge.ts',
  'src/process/bridge/assistantHubBridge.ts',
  'src/process/services/skillUpdate/SkillUpdateService.ts',
  'src/webserver/routes/apiRoutes.ts',
  'skills/_builtin/sudoclaw-skill-installer/scripts/sudoclaw-skill.mjs',
] as const

export interface HubClientSource {
  productVersion: string
  commit: string
  files: Record<string, string>
}

export interface HubRouteEvidence {
  product_version: string
  commit: string
  source_file: string
  source_line: number
}

export interface HubClientRoute {
  method: string
  path: string
  query_parameters: string[]
  multipart_fields: string[]
  authorization_header: boolean
  evidence: HubRouteEvidence[]
}

export interface HubClientContract {
  schema_version: 1
  supported_clients: Array<{ product_version: string; commit: string }>
  routes: HubClientRoute[]
  artifact_download: {
    method: 'GET'
    source_fields: string[]
    requires_absolute_url: boolean
    authorization_header_observed: boolean
    followed_redirect_statuses: number[]
  }
}

interface ParsedRequest {
  method: string
  path: string
  queryParameters: string[]
  multipartFields: string[]
  authorizationHeader: boolean
  line: number
}

interface VariableDeclarationEntry {
  position: number
  initializer: ts.Expression
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`
  return ''
}

function nearestFunction(node: ts.Node): ts.FunctionLikeDeclaration | ts.SourceFile {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return node.getSourceFile()
}

function objectProperty(object: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  if (!object) return undefined
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer
  }
  return undefined
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined
}

function renderUrlExpression(
  expression: ts.Expression,
  declarations: Map<string, VariableDeclarationEntry[]>,
  before: number,
  seen = new Set<string>(),
): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  if (ts.isParenthesizedExpression(expression)) return renderUrlExpression(expression.expression, declarations, before, seen)
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'params') return ''
    if (/id$/i.test(expression.text)) return `:${expression.text}`
    if (seen.has(expression.text)) return `:${expression.text}`
    const entries = declarations.get(expression.text) ?? []
    const declaration = entries.filter((entry) => entry.position < before).at(-1)
    if (!declaration) return `:${expression.text}`
    seen.add(expression.text)
    return renderUrlExpression(declaration.initializer, declarations, before, seen)
  }
  if (ts.isCallExpression(expression)) {
    if (callName(expression.expression) === 'encodeURIComponent' && expression.arguments[0]) {
      return renderUrlExpression(expression.arguments[0], declarations, before, seen)
    }
    return ''
  }
  if (ts.isTemplateExpression(expression)) {
    let rendered = expression.head.text
    for (const span of expression.templateSpans) {
      rendered += renderUrlExpression(span.expression, declarations, before, new Set(seen))
      rendered += span.literal.text
    }
    return rendered
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return renderUrlExpression(expression.left, declarations, before, new Set(seen))
      + renderUrlExpression(expression.right, declarations, before, new Set(seen))
  }
  return ''
}

function normalizeHubPath(rendered: string): string | undefined {
  const match = rendered.match(/\/api\/(?:skills|assistants|categories)(?:\/cursor)?(?:\/:[A-Za-z][A-Za-z0-9_]*)?/)
  if (!match) return undefined
  return match[0]
    .replace(/^\/api\/skills\/:[^/]+$/, '/api/skills/:skillId')
    .replace(/^\/api\/assistants\/:[^/]+$/, '/api/assistants/:assistantId')
}

function collectQueryParameters(scope: ts.Node, renderedUrl: string): string[] {
  const values = new Set<string>()
  const parameterObjects = new Set<string>()
  const query = renderedUrl.split('?')[1]
  if (query) {
    for (const part of query.split('&')) {
      const key = part.split('=')[0]
      if (key && !key.startsWith(':')) values.add(key)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isNewExpression(node.initializer)
      && callName(node.initializer.expression) === 'URLSearchParams') {
      parameterObjects.add(node.name.text)
      const argument = node.initializer.arguments?.[0]
      if (argument && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const key = propertyName(property.name)
            if (key) values.add(key)
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && parameterObjects.has(node.expression.expression.text)
      && (node.expression.name.text === 'set' || node.expression.name.text === 'append')) {
      const key = stringValue(node.arguments[0])
      if (key) values.add(key)
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return [...values].sort()
}

function collectMultipartFields(scope: ts.Node, body: ts.Expression | undefined): string[] {
  if (!body || !ts.isIdentifier(body)) return []
  const formName = body.text
  const values = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === formName
      && node.expression.name.text === 'append') {
      const field = stringValue(node.arguments[0])
      if (field) values.add(field)
    }
    if (ts.isCallExpression(node)
      && (callName(node.expression) === 'appendOptionalFormValue' || callName(node.expression) === 'appendOptionalFormList')
      && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === formName) {
      const field = stringValue(node.arguments[1])
      if (field) values.add(field)
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return [...values].sort()
}

function parseRequests(fileName: string, sourceText: string): ParsedRequest[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const declarations = new Map<string, VariableDeclarationEntry[]>()
  const collectDeclarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = declarations.get(node.name.text) ?? []
      entries.push({ position: node.getStart(sourceFile), initializer: node.initializer })
      declarations.set(node.name.text, entries)
    }
    ts.forEachChild(node, collectDeclarations)
  }
  collectDeclarations(sourceFile)

  const requests: ParsedRequest[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression)
      if ((name === 'fetch' || name === 'fetchJson' || name === 'https.get' || name === 'http.get' || name === 'client.get') && node.arguments[0]) {
        const renderedUrl = renderUrlExpression(node.arguments[0], declarations, node.getStart(sourceFile))
        const path = normalizeHubPath(renderedUrl)
        if (path) {
          const options = node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])
            ? node.arguments[1]
            : undefined
          const method = stringValue(objectProperty(options, 'method'))?.toUpperCase() ?? 'GET'
          const scope = nearestFunction(node)
          const scopeText = scope.getText(sourceFile)
          requests.push({
            method,
            path,
            queryParameters: collectQueryParameters(scope, renderedUrl),
            multipartFields: method === 'POST'
              ? collectMultipartFields(scope, objectProperty(options, 'body'))
              : [],
            authorizationHeader: Boolean(options?.getText(sourceFile).includes('Authorization'))
              || (name === 'fetchJson' && sourceText.includes('Authorization')),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return requests
}

export function extractHubClientContract(clients: HubClientSource[]): HubClientContract {
  const merged = new Map<string, HubClientRoute>()
  const sourceFields = new Set<string>()
  let requiresAbsoluteUrl = false
  let authorizationHeaderObserved = false
  const followedRedirectStatuses = new Set<number>()

  for (const client of clients) {
    for (const [sourceFile, sourceText] of Object.entries(client.files)) {
      for (const field of sourceText.matchAll(/\bsource(?:_url|Url)\b/g)) sourceFields.add(field[0])
      if (/new URL\([^)]*source_?url|new URL\(url\)/.test(sourceText)) requiresAbsoluteUrl = true
      if (/https?\.get\([^)]*source_?url[\s\S]{0,160}Authorization/.test(sourceText)) authorizationHeaderObserved = true
      for (const status of sourceText.matchAll(/statusCode\s*===\s*(301|302)/g)) {
        followedRedirectStatuses.add(Number(status[1]))
      }

      for (const request of parseRequests(sourceFile, sourceText)) {
        const key = `${request.method} ${request.path}`
        const route = merged.get(key) ?? {
          method: request.method,
          path: request.path,
          query_parameters: [],
          multipart_fields: [],
          authorization_header: false,
          evidence: [],
        }
        route.query_parameters = [...new Set([...route.query_parameters, ...request.queryParameters])].sort()
        route.multipart_fields = [...new Set([...route.multipart_fields, ...request.multipartFields])].sort()
        route.authorization_header ||= request.authorizationHeader
        route.evidence.push({
          product_version: client.productVersion,
          commit: client.commit,
          source_file: sourceFile,
          source_line: request.line,
        })
        merged.set(key, route)
      }
    }
  }

  return {
    schema_version: 1,
    supported_clients: clients.map((client) => ({
      product_version: client.productVersion,
      commit: client.commit,
    })),
    routes: [...merged.values()].sort((left, right) => {
      const leftKey = `${left.method} ${left.path.replaceAll(':', '~')}`
      const rightKey = `${right.method} ${right.path.replaceAll(':', '~')}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    }),
    artifact_download: {
      method: 'GET',
      source_fields: [...sourceFields].sort(),
      requires_absolute_url: requiresAbsoluteUrl,
      authorization_header_observed: authorizationHeaderObserved,
      followed_redirect_statuses: [...followedRedirectStatuses].sort(),
    },
  }
}

export function missingHubRoutes(
  contract: HubClientContract,
  routes: Array<{ method: string; path: string }>,
): string[] {
  const available = new Set(routes.map((route) => `${route.method.toUpperCase()} ${route.path}`))
  return contract.routes
    .map((route) => `${route.method} ${route.path}`)
    .filter((route) => !available.has(route))
}

export function extractRegisteredHonoRoutes(sourceText: string): Array<{ method: string; path: string }> {
  const sourceFile = ts.createSourceFile('compat-app.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const routes: Array<{ method: string; path: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app') {
      const method = node.expression.name.text.toUpperCase()
      const path = stringValue(node.arguments[0])
      if (path && ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method)) {
        routes.push({ method, path })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return routes
}

interface SupportedClientsFile {
  clients: Array<{ product_version: string; commit: string }>
}

function readClientSources(repository: string, manifest: SupportedClientsFile): HubClientSource[] {
  return manifest.clients.map((client) => ({
    productVersion: client.product_version,
    commit: client.commit,
    files: Object.fromEntries(CLIENT_HUB_FILES.map((file) => [
      file,
      execFileSync('git', ['-C', repository, 'show', `${client.commit}:${file}`], { encoding: 'utf8' }),
    ])),
  }))
}

function main(): void {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--source')
  if (sourceIndex < 0 || !args[sourceIndex + 1]) {
    throw new Error('Usage: --source <sudowork-repository> [--check]')
  }
  const source = resolve(args[sourceIndex + 1])
  const output = resolve('contracts/sudowork/hub-client-api.json')
  const supported = JSON.parse(readFileSync(resolve('contracts/sudowork/supported-clients.json'), 'utf8')) as SupportedClientsFile
  const contract = extractHubClientContract(readClientSources(source, supported))
  const serialized = `${JSON.stringify(contract, null, 2)}\n`

  if (args.includes('--check')) {
    const existing = readFileSync(output, 'utf8')
    if (existing !== serialized) throw new Error('Hub client API contract is stale')
    const mossRoutes = extractRegisteredHonoRoutes(
      readFileSync(resolve('src/server/api/compat/sudowork/app.ts'), 'utf8'),
    )
    const missing = missingHubRoutes(contract, mossRoutes)
    if (missing.length > 0) throw new Error(`Moss is missing Hub client routes: ${missing.join(', ')}`)
    console.log(`Hub client API contract is current: ${contract.routes.length} routes`)
    return
  }
  writeFileSync(output, serialized)
  console.log(`Wrote ${contract.routes.length} Hub client routes to ${output}`)
}

if (import.meta.main) main()
