import { rewriteImports, ServerPlugin } from './index'
import {
  debugHmr,
  ensureMapEntry,
  hmrClientPublicPath,
  importerMap
} from './serverPluginHmr'
import { init as initLexer } from 'es-module-lexer'
import { cleanUrl, readBody, injectScriptToHtml } from '../utils'
import LRUCache from 'lru-cache'
import path from 'path'
import slash from 'slash'
import chalk from 'chalk'

const debug = require('debug')('vite:rewrite')

const rewriteHtmlPluginCache = new LRUCache({ max: 20 })

export const htmlRewritePlugin: ServerPlugin = ({
  root,
  app,
  watcher,
  resolver,
  config
}) => {
  const devInjectionCode =
    `\n<script type="module">\n` +
    // import hmr client first to establish connection
    `import "${hmrClientPublicPath}"\n` +
    // inject process.env.NODE_ENV
    // since some ESM builds expect these to be replaced by the bundler
    `window.process = { env: { NODE_ENV: ${JSON.stringify(
      config.mode || 'development'
    )} }}\n` +
    `</script>\n`

  const scriptRE = /(<script\b[^>]*>)([\s\S]*?)<\/script>/gm
  const srcRE = /\bsrc=(?:"([^"]+)"|'([^']+)'|([^'"\s]+)\b)/

  async function rewriteHtml(importer: string, html: string) {
    await initLexer
    html = html!.replace(scriptRE, (matched, openTag, script) => {
      if (script) {
        return `${openTag}${rewriteImports(
          root,
          script,
          importer,
          resolver
        )}</script>`
      } else {
        const srcAttr = openTag.match(srcRE)
        if (srcAttr) {
          // register script as a import dep for hmr
          const importee = resolver.normalizePublicPath(
            cleanUrl(slash(path.resolve('/', srcAttr[1] || srcAttr[2])))
          )
          debugHmr(`        ${importer} imports ${importee}`)
          ensureMapEntry(importerMap, importee).add(importer)
        }
        return matched
      }
    })
    return injectScriptToHtml(html, devInjectionCode)
  }

  app.use(async (ctx, next) => {
    await next()

    if (ctx.status === 304) {
      return
    }

    if (ctx.response.is('html') && ctx.body) {
      const importer = ctx.path
      const html = await readBody(ctx.body)
      if (rewriteHtmlPluginCache.has(html)) {
        debug(`${ctx.path}: serving from cache`)
        ctx.body = rewriteHtmlPluginCache.get(html)
      } else {
        if (!html) return
        ctx.body = await rewriteHtml(importer, html)
        rewriteHtmlPluginCache.set(html, ctx.body)
      }
      return
    }
  })

  watcher.on('change', (file) => {
    const path = resolver.fileToRequest(file)
    if (path.endsWith('.html')) {
      debug(`${path}: cache busted`)
      watcher.send({
        type: 'full-reload',
        path,
        timestamp: Date.now()
      })
      console.log(chalk.green(`[vite] `) + ` ${path} page reloaded.`)
    }
  })
}
