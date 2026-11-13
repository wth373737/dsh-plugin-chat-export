import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 一个用绝对路径安装的 bundle 解析不到 profile 里的宿主包，而设置页是从
 * schemastery schema 投影出来的，必须用 Harness 加载的同一个模块实例——
 * 第二份拷贝会产生投影不认识的 schema。
 *
 * 所以：先试常规解析（当它真是声明依赖时成立），再从 profile 根解析并导入 ESM 构建。
 */
function baseCandidates() {
  const bases = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) bases.push(value)
  }

  push(process.env.DSH_PROFILE_DIR)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    const profiles = path.join(home, 'profiles')
    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) push(path.join(profiles, entry.name))
      }
    } catch {
      // 没有 profiles 目录：本次启动不带 profile。
    }
  }

  return bases
}

export async function loadSchemastery() {
  try {
    const direct = await import('@deepseek-ai/schemastery')
    if (direct && direct.default) return direct.default
  } catch {
    // 插件目录解析不到，继续走 profile。
  }

  for (const base of baseCandidates()) {
    try {
      const require = createRequire(path.join(base, 'package.json'))
      const entry = require.resolve('@deepseek-ai/schemastery')
      const root = path.resolve(path.dirname(entry), '..')
      const esm = path.join(root, 'lib', 'index.mjs')
      const loaded = await import(pathToFileURL(esm).href)
      if (loaded && loaded.default) return loaded.default
    } catch {
      // 换下一个候选。
    }
  }

  return null
}
